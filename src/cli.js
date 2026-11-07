import fs from 'node:fs';
import { available, allAgents, which } from './agents.js';
import { projectRoot } from './context.js';
import * as install from './install.js';
import { serve } from './mcp.js';
import * as store from './store.js';
import { createTools, INSTRUCTIONS } from './tools.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `relay ${version} — stop copy-pasting between coding agents

Setup
  relay init                 Connect relay to every agent on this machine
  relay doctor               Show which agents are installed and connected
  relay uninstall            Remove relay from every agent

From your terminal (inside any agent, just ask in plain words instead)
  relay handoff <agent> <task>     Give a task to an agent (it can edit files)
  relay ask <agent> <question>     Ask an agent something (read-only)
  relay review <agent> [focus]     Get the current diff reviewed
  relay thread [-n 20]             What the agents did in this project
  relay clear                      Forget this project's history and sessions

Agents: claude, codex, gemini, cursor (+ your own in ~/.relay/agents.json)
`;

const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function fromTerminal(kind, args) {
  const [to, ...rest] = args;
  const text = rest.join(' ').trim();
  if (!to || (kind !== 'review' && !text)) {
    console.error(`usage: relay ${kind} <agent> ${kind === 'review' ? '[focus]' : `<${kind === 'ask' ? 'question' : 'task'}>`}`);
    process.exit(1);
  }
  const { callTool } = createTools('you');
  const field = { handoff: 'task', ask: 'question', review: 'focus' }[kind];
  process.stderr.write(dim(`→ ${to} is working…\n`));
  const started = Date.now();
  const timer = setInterval(() => process.stderr.write(dim(`  …${Math.round((Date.now() - started) / 1000)}s\n`)), 15000);
  try {
    console.log(await callTool(kind, { to, [field]: text || undefined, cwd: process.cwd() }));
  } finally {
    clearInterval(timer);
  }
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

    case 'init': {
      const results = install.init();
      console.log(`relay ${version}\n`);
      for (const { target, state, error } of results) {
        const mark = state === 'connected' ? green('✓') : state === 'error' ? red('✗') : dim('–');
        const note = state === 'connected' ? '' : state === 'error' ? red(error) : dim('not installed');
        console.log(`  ${mark} ${target.label.padEnd(12)} ${note}`);
      }
      const agents = available();
      console.log(`\nAgents relay can hand work to: ${agents.length ? agents.join(', ') : 'none found'}`);
      if (results.some((r) => r.state === 'connected')) {
        console.log(`\nDone. Restart any open agent sessions, then just say:\n  ${green('"ask codex to review this"')}   or   ${green('"hand the tests to claude"')}`);
      } else {
        console.log('\nNo agents found. Install Claude Code, Codex, Gemini CLI or Cursor, then run `relay init` again.');
      }
      return;
    }

    case 'doctor': {
      console.log(`relay ${version}\n\nConnected to (can call relay):`);
      for (const { target, found, connected } of install.status()) {
        const mark = connected ? green('✓') : found ? red('✗') : dim('–');
        const note = connected ? '' : found ? 'found, not connected: run `relay init`' : dim('not installed');
        console.log(`  ${mark} ${target.label.padEnd(12)} ${note}`);
      }
      console.log('\nCan hand work to:');
      for (const [name, agent] of Object.entries(allAgents())) {
        const bin = which(agent.bin);
        console.log(`  ${bin ? green('✓') : dim('–')} ${name.padEnd(12)} ${bin ? dim(bin) : dim(`no "${agent.bin}" on PATH`)}`);
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
