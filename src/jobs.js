// Every delegation runs as a job: a detached worker process that survives the caller,
// streams a live log you can watch, and records the result for whoever asks next.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAgents, loadConfig, run, which } from './agents.js';
import { append, clip, home, setSession } from './store.js';

const dir = () => path.join(home(), 'jobs');
export const jobFile = (id) => path.join(dir(), `${id}.json`);
export const logFile = (id) => path.join(dir(), `${id}.log`);
const DONE = new Set(['done', 'failed']);

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

export function load(id) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
  // A worker that died without recording a result (machine slept, killed…) is a failure, not "running" forever.
  if (job.status === 'running' && job.pid && !alive(job.pid)) {
    job.status = 'failed';
    job.error = 'The relay worker stopped unexpectedly.';
    job.endedAt = new Date().toISOString();
    save(job);
  }
  return job;
}

export function save(job) {
  writeAtomic(jobFile(job.id), JSON.stringify(job, null, 2));
}

export function update(id, patch) {
  const job = load(id);
  if (!job) return null;
  Object.assign(job, patch);
  save(job);
  return job;
}

export function create(spec) {
  const job = { id: crypto.randomBytes(3).toString('hex'), status: 'queued', createdAt: new Date().toISOString(), delivered: false, ...spec };
  fs.mkdirSync(dir(), { recursive: true });
  save(job);
  fs.writeFileSync(logFile(job.id), '');
  return job;
}

export function start(job) {
  const script = fileURLToPath(new URL('../bin/relay.js', import.meta.url));
  const child = spawn(process.execPath, [script, 'worker', job.id], {
    cwd: job.cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return update(job.id, { workerPid: child.pid });
}

export function list({ root, limit = 20 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((f) => load(f.slice(0, -5)))
    .filter((j) => j && (!root || j.root === root))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export function lastLogLine(id) {
  try {
    const text = fs.readFileSync(logFile(id), 'utf8').trimEnd();
    return text.slice(text.lastIndexOf('\n') + 1).replace(/^\d\d:\d\d:\d\d /, '');
  } catch {
    return '';
  }
}

export async function wait(id, { timeoutMs = 600000, onTick } = {}) {
  const until = Date.now() + timeoutMs;
  let lastTick = 0;
  for (;;) {
    const job = load(id);
    if (!job || DONE.has(job.status)) return job;
    if (Date.now() >= until) return job;
    if (onTick && Date.now() - lastTick > 5000) {
      lastTick = Date.now();
      onTick(job, lastLogLine(id));
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export const isDone = (job) => Boolean(job && DONE.has(job.status));

// Jobs this agent started in this project that finished but whose result it hasn't seen yet.
export function undelivered(from, root) {
  return list({ root, limit: 50 }).filter((j) => j.from === from && isDone(j) && !j.delivered);
}

export function markDelivered(id) {
  return update(id, { delivered: true });
}

export function resumeHint(job) {
  const agent = allAgents()[job.to];
  if (!job.agentSession || !agent?.resumeCommand) return '';
  return agent.resumeCommand(job.agentSession);
}

function notify(title, body) {
  if (process.env.RELAY_NOTIFY === '0' || loadConfig().notify === false) return;
  try {
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification ${JSON.stringify(clip(body, 180))} with title ${JSON.stringify(title)}`], { stdio: 'ignore' }).unref();
    } else if (process.platform === 'linux' && which('notify-send')) {
      spawn('notify-send', [title, clip(body, 180)], { stdio: 'ignore' }).unref();
    }
  } catch {}
}

// Runs inside the detached `relay worker <id>` process.
export async function runWorker(id) {
  const job = load(id);
  if (!job) return;
  update(id, { status: 'running', startedAt: new Date().toISOString(), pid: process.pid });
  const log = (line) => {
    const stamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(logFile(id), String(line).split('\n').map((l) => `${stamp} ${l}`).join('\n') + '\n');
  };
  log(`relay ▸ ${job.from} → ${job.to} (${job.kind}) in ${job.cwd}`);
  try {
    const res = await run(job.to, job.prompt, {
      cwd: job.cwd,
      readOnly: job.readOnly,
      session: job.session,
      onLog: log,
      onSession: (s) => update(id, { agentSession: s }),
    });
    if (res.session && job.kind !== 'review') setSession(job.root, job.to, res.session, { readOnly: Boolean(job.readOnly) });
    // history first, then status, so anyone waiting on the status also sees the history entry
    append(job.root, { from: job.from, to: job.to, kind: job.kind, task: clip(job.task, 4000), result: clip(res.text, 8000), session: res.session, ms: res.ms, job: id });
    update(id, { status: 'done', endedAt: new Date().toISOString(), ms: res.ms, result: res.text, agentSession: res.session || load(id)?.agentSession });
    log(`relay ▸ done in ${Math.round(res.ms / 1000)}s`);
    notify(`relay: ${job.to} finished`, res.text.split('\n').find((l) => l.trim()) || 'Done');
  } catch (err) {
    append(job.root, { from: job.from, to: job.to, kind: job.kind, task: clip(job.task, 4000), error: err.message, job: id });
    update(id, { status: 'failed', endedAt: new Date().toISOString(), error: err.message });
    log(`relay ▸ failed: ${err.message}`);
    notify(`relay: ${job.to} failed`, err.message);
  }
}
