import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { allAgents, binFor, signedIn, which } from './agents.js';
import { projectRoot } from './context.js';
import { claudeHook, catchUp } from './hooks.js';
import * as install from './install.js';
import * as jobs from './jobs.js';
import { serve } from './mcp.js';
import * as store from './store.js';
import { createTools, describeResult, INSTRUCTIONS } from './tools.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `relay ${version} — stop copy-pasting between coding agents

Setup
  relay init                 Connect relay to every agent on this machine
  relay doctor               Show which agents are installed and connected
  relay uninstall            Remove relay from every agent

Inside any agent, just ask: "ask codex to review this", "hand the tests to claude".

From your terminal
  relay handoff <agent> <task>     Give a task to an agent (it can edit files and run tests)
  relay ask <agent> <question>     Ask an agent something (read-only)
  relay review <agent> [focus]     Get the current diff reviewed
      add --bg to return immediately and let it work in the background

  relay watch [job]          Watch an agent work, live
  relay jobs                 Recent jobs in this project
  relay open <job|agent>     Open that agent's session in its own app to continue it yourself
  relay thread [-n 20]       What the agents did in this project
  relay clear                Forget this project's history and sessions

Agents: claude, codex, gemini, cursor (+ your own in ~/.relay/agents.json)
`;

const tty = process.stdout.isTTY;
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function bool(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });

function pickJob(id) {
  if (id) return jobs.load(id);
  const root = projectRoot(process.cwd());
  const here = jobs.list({ root, limit: 20 });
  const anywhere = jobs.list({ limit: 20 });
  return here.find((j) => !jobs.isDone(j)) || anywhere.find((j) => !jobs.isDone(j)) || here[0] || anywhere[0] || null;
}

// Stream a job's live log until it finishes, then print the result.
async function watch(job, { quietHeader = false } = {}) {
  if (!job) {
    console.log('No relay jobs yet.');
    return;
  }
  if (!quietHeader) console.log(bold(`▸ ${job.from} → ${job.to} (${job.kind}) · job ${job.id}`) + dim(`  ${job.cwd}`));
  let offset = 0;
  const flush = () => {
    let text = '';
    try {
      const fd = fs.openSync(jobs.logFile(job.id), 'r');
      const size = fs.fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        text = buf.toString('utf8');
      }
      fs.closeSync(fd);
    } catch {}
    if (text) process.stdout.write(text.replace(/^(\d\d:\d\d:\d\d) /gm, (m, t) => dim(`${t} `)));
  };
  for (;;) {
    flush();
    const current = jobs.load(job.id);
    if (!current || jobs.isDone(current)) {
      flush();
      if (current) {
        jobs.markDelivered(current.id);
        console.log('\n' + (current.status === 'failed' ? red(describeResult(current)) : describeResult(current)));
      }
      return current;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function fromTerminal(kind, args) {
  const background = bool(args, '--bg');
  const [to, ...rest] = args;
  const text = rest.join(' ').trim();
  if (!to || (kind !== 'review' && !text)) {
    console.error(`usage: relay ${kind} <agent> ${kind === 'review' ? '[focus]' : `<${kind === 'ask' ? 'question' : 'task'}>`} [--bg]`);
    process.exit(1);
  }
  const { callTool } = createTools('you');
  const field = { handoff: 'task', ask: 'question', review: 'focus' }[kind];
  const reply = await callTool(kind, { to, [field]: text || undefined, cwd: process.cwd(), background: true, conversation: false });
  const id = /job ([0-9a-f]{6})/.exec(reply)?.[1];
  if (background || !id) {
    console.log(reply);
    return;
  }
  await watch(jobs.load(id));
}

function openSession(target) {
  let agentName;
  let session;
  let cwd = process.cwd();
  const job = target && /^[0-9a-f]{6}$/.test(target) ? jobs.load(target) : null;
  if (job) {
    agentName = job.to;
    session = job.agentSession;
    cwd = job.cwd;
  } else if (target && allAgents()[target]) {
    agentName = target;
    session = store.getSession(projectRoot(cwd), target);
  } else {
    const last = pickJob();
    if (!last) throw new Error('Nothing to open yet. Usage: relay open <job|agent>');
    return openSession(last.id);
  }
  const agent = allAgents()[agentName];
  if (!session || !agent?.resumeCommand) throw new Error(`No ${agentName} session to open for this project yet.`);
  const [cmd, ...cmdArgs] = agent.resumeCommand(session).split(' ');
  const bin = binFor(agent) || which(cmd) || cmd;
  console.log(dim(`→ ${agent.resumeCommand(session)}  (in ${cwd})`));
  const child = spawn(bin, cmdArgs, { cwd, stdio: 'inherit' });
  return new Promise((resolve) => child.on('close', resolve));
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();

  switch (command) {
    case 'serve': {
      const as = flag(args, '--as', process.env.RELAY_AS || 'agent');
      const { listTools, callTool } = createTools(as);
      serve({ name: 'relay', version, instructions: INSTRUCTIONS, listTools, callTool });
      return;
    }

    case 'worker':
      return jobs.runWorker(args[0]);

    case 'hook': {
      // Called by agents' prompt hooks. Must be fast and must never break the agent.
      const agent = args[0];
      let input = {};
      try {
        input = JSON.parse((await readStdin()) || '{}');
      } catch {}
      try {
        if (agent === 'claude') {
          const out = claudeHook(input);
          if (out) process.stdout.write(out);
        } else {
          const text = catchUp({ agent, sessionId: input.session_id, cwd: input.cwd, transcript: input.transcript_path });
          if (text) process.stdout.write(text);
        }
      } catch {}
      return;
    }

    case 'init': {
      const results = install.init();
      console.log(`relay ${version}\n`);
      for (const { target, state, error, extras } of results) {
        const mark = state === 'connected' ? green('✓') : state === 'error' ? red('✗') : dim('–');
        const note = state === 'connected' ? dim(extras || '') : state === 'error' ? red(error) : dim('not installed');
        console.log(`  ${mark} ${target.label.padEnd(12)} ${note}`);
      }
      const agents = Object.entries(allAgents()).filter(([, a]) => binFor(a)).map(([n]) => n);
      console.log(`\nAgents relay can hand work to: ${agents.length ? agents.join(', ') : 'none found'}`);
      if (results.some((r) => r.state === 'connected')) {
        console.log(`\nDone. Restart any open agent sessions, then just say:\n  ${green('"ask codex to review this"')}   or   ${green('"hand the tests to claude"')}`);
        console.log(dim('Watch any handoff live with `relay watch`.'));
      } else {
        console.log('\nNo agents found. Install Claude Code, Codex, Gemini CLI or Cursor, then run `relay init` again.');
      }
      return;
    }

    case 'doctor': {
      console.log(`relay ${version}\n\nConnected to (can call relay):`);
      for (const { target, found, connected, extras } of install.status()) {
        const mark = connected ? green('✓') : found ? red('✗') : dim('–');
        const note = connected ? dim(extras || '') : found ? 'found, not connected: run `relay init`' : dim('not installed');
        console.log(`  ${mark} ${target.label.padEnd(12)} ${note}`);
      }
      console.log('\nCan hand work to:');
      for (const [name, agent] of Object.entries(allAgents())) {
        const bin = binFor(agent);
        if (!bin) {
          console.log(`  ${dim('–')} ${name.padEnd(12)} ${dim(`no "${agent.bin}" on PATH`)}`);
          continue;
        }
        const auth = signedIn(agent);
        const mark = auth === false ? red('✗') : green('✓');
        const note = auth === false ? red(`signed out: ${/^[a-z-]+ [a-z]+$/.test(agent.auth.fix) ? `run \`${agent.auth.fix}\`` : agent.auth.fix}`) : dim(bin);
        console.log(`  ${mark} ${name.padEnd(12)} ${note}`);
      }
      return;
    }

    case 'uninstall': {
      for (const { target, state, error } of install.uninstall()) {
        console.log(`  ${state === 'error' ? red('✗') : dim('–')} ${target.label.padEnd(12)} ${state === 'error' ? error : 'removed'}`);
      }
      console.log(`\nrelay is disconnected. History is kept in ${store.home()} (delete it to wipe everything).`);
      return;
    }

    case 'handoff':
    case 'ask':
    case 'review':
      return fromTerminal(command, args);

    case 'watch':
      return void (await watch(pickJob(args[0])));

    case 'jobs': {
      const all = bool(args, '--all');
      const list = jobs.list({ root: all ? undefined : projectRoot(process.cwd()), limit: 20 });
      if (!list.length) return console.log('No relay jobs here yet.');
      for (const j of list) {
        const state = j.status === 'done' ? green('done') : j.status === 'failed' ? red('failed') : bold(j.status);
        const tail = jobs.isDone(j) ? (j.error || store.clip(j.result, 90)) : jobs.lastLogLine(j.id);
        console.log(`${j.id}  ${j.from} → ${j.to} (${j.kind})  ${state}  ${dim(j.createdAt.slice(0, 16).replace('T', ' '))}\n        ${dim(String(tail || '').replace(/\s+/g, ' ').slice(0, 110))}`);
      }
      return;
    }

    case 'open':
      return void (await openSession(args[0]));

    case 'thread': {
      const limit = Number(flag(args, '-n', 20)) || 20;
      console.log(store.formatThread(store.read(projectRoot(process.cwd()), limit), { max: 2000 }));
      return;
    }

    case 'clear': {
      store.clear(projectRoot(process.cwd()));
      console.log('Cleared relay history and sessions for this project.');
      return;
    }

    case '-v':
    case '--version':
    case 'version':
      console.log(version);
      return;

    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return;

    default:
      console.error(`Unknown command: ${command}\n`);
      process.stdout.write(HELP);
      process.exit(1);
  }
}
