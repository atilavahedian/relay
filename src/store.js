// Shared state: one append-only thread per project, plus the session id
// relay last used with each agent so follow-ups continue the same conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const home = () => process.env.RELAY_HOME || path.join(os.homedir(), '.relay');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function projectKey(root) {
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  const name = path.basename(root).replace(/[^\w.-]/g, '_') || 'root';
  return `${name}-${hash}`;
}

const threadFile = (root) => path.join(home(), 'threads', `${projectKey(root)}.jsonl`);
const sessionsFile = () => path.join(home(), 'sessions.json');

export function append(root, entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  ensureDir(path.dirname(threadFile(root)));
  fs.appendFileSync(threadFile(root), JSON.stringify(record) + '\n');
  return record;
}

function threadLines(root) {
  try {
    return fs.readFileSync(threadFile(root), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export const count = (root) => threadLines(root).length;

// Entries appended after the first `from` ones (used to tell an agent what it missed).
export function readSince(root, from) {
  return parseLines(threadLines(root).slice(from));
}

export function read(root, limit = 20) {
  return parseLines(threadLines(root).slice(-limit));
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn line rather than failing the whole read
    }
  }
  return out;
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function getSession(root, agent) {
  return loadSessions()[projectKey(root)]?.[agent];
}

export function setSession(root, agent, id) {
  const all = loadSessions();
  const key = projectKey(root);
  all[key] = { ...all[key], [agent]: id };
  writeAtomic(sessionsFile(), JSON.stringify(all, null, 2));
}

export function clear(root) {
  fs.rmSync(threadFile(root), { force: true });
  const all = loadSessions();
  delete all[projectKey(root)];
  writeAtomic(sessionsFile(), JSON.stringify(all, null, 2));
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

export function formatThread(entries, { max = 4000 } = {}) {
  if (!entries.length) return 'No relay activity in this project yet.';
  return entries
    .map((e) => {
      const time = (e.ts || '').replace('T', ' ').slice(0, 16);
      if (e.kind === 'note') return `${time}  ${e.from} noted:\n  ${clip(e.text, max)}`;
      const outcome = e.error ? `failed: ${e.error}` : clip(e.result, max);
      return `${time}  ${e.from} → ${e.to} (${e.kind})\n  task: ${clip(e.task, max)}\n  reply: ${outcome}`;
    })
    .join('\n\n');
}
