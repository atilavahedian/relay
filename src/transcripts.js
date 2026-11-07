// Reads the calling agent's own session transcript, so the receiving agent sees the
// recent conversation with the user, not just a one-line brief.
// Transcript formats are internal to each CLI, so everything here is best-effort and
// fails closed: if anything looks unfamiliar we simply send no conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './store.js';

const MAX_MESSAGES = 14;
const MAX_PER_MESSAGE = 1500;
const MAX_TOTAL = 12000;
const TAIL_BYTES = 3 * 1024 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const jsonLines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// Remove harness wrappers (system reminders, slash-command echoes, environment blocks).
export function cleanText(text) {
  return String(text || '')
    .replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+|environment_context|user_instructions|permissions[\w -]*|INSTRUCTIONS)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
}

export function formatConversation(messages, assistantName) {
  const picked = [];
  let total = 0;
  for (const m of messages.slice(-MAX_MESSAGES).reverse()) {
    let text = m.text.length > MAX_PER_MESSAGE ? `${m.text.slice(0, MAX_PER_MESSAGE)}…` : m.text;
    const line = `${m.role === 'user' ? 'user' : assistantName}: ${text}`;
    if (total + line.length > MAX_TOTAL) break;
    picked.push(line);
    total += line.length;
  }
  return picked.reverse().join('\n\n');
}

// ---------------------------------------------------------------- Claude Code
const claudeDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
export const encodeClaudeProject = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// The UserPromptSubmit hook records which transcript belongs to which project.
const hookStateFile = () => path.join(home(), 'sessions-live.json');
export function rememberLiveSession(agent, cwd, info) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(hookStateFile(), 'utf8'));
  } catch {}
  all[`${agent}:${safeReal(cwd)}`] = { ...info, at: Date.now() };
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(hookStateFile(), JSON.stringify(all, null, 2));
}
export function liveSession(agent, cwd) {
  try {
    return JSON.parse(fs.readFileSync(hookStateFile(), 'utf8'))[`${agent}:${safeReal(cwd)}`];
  } catch {
    return undefined;
  }
}

function newestFile(dir, filter = () => true) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && filter(f))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f;
  } catch {
    return undefined;
  }
}

export function claudeMessages(file) {
  const out = [];
  for (const e of jsonLines(readTail(file))) {
    if (e.isSidechain || e.isMeta) continue;
    const content = e.message?.content;
    if (e.type === 'user' && e.message?.role === 'user') {
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) continue;
      const raw = typeof content === 'string' ? content : (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const text = cleanText(raw);
      if (text && !text.startsWith('[relay]')) out.push({ role: 'user', text });
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      const text = cleanText(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      if (text) out.push({ role: 'assistant', text });
    }
  }
  return out;
}

function claudeTranscript(cwd) {
  const live = liveSession('claude', cwd);
  if (live?.transcript && fs.existsSync(live.transcript) && Date.now() - live.at < 12 * 3600 * 1000) return live.transcript;
  return newestFile(path.join(claudeDir(), encodeClaudeProject(cwd)));
}

const safeReal = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// ---------------------------------------------------------------------- Codex
const codexSessions = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

function recentCodexRollouts(days = 3) {
  const files = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const t = new Date(now.getTime() - d * 86400000);
    const dir = path.join(codexSessions(), String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    try {
      for (const f of fs.readdirSync(dir)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) files.push(path.join(dir, f));
    } catch {}
  }
  return files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f);
}

export function codexMeta(file) {
  const first = jsonLines(readHead(file)).find((e) => e.type === 'session_meta');
  return first?.payload || null;
}

export function codexMessages(file) {
  const out = [];
  for (const e of jsonLines(readTail(file))) {
    const p = e.payload;
    if (e.type !== 'response_item' || p?.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
    const text = cleanText((p.content || []).map((c) => c.text || '').join('\n'));
    if (!text || text.startsWith('[relay]') || text.startsWith('# AGENTS.md')) continue;
    out.push({ role: p.role, text });
  }
  return out;
}

function codexTranscript(cwd) {
  const live = liveSession('codex', cwd);
  if (live?.transcript && fs.existsSync(live.transcript) && Date.now() - live.at < 12 * 3600 * 1000) return live.transcript;
  for (const f of recentCodexRollouts().slice(0, 60)) {
    const meta = codexMeta(f);
    // skip headless sessions (including the ones relay itself starts)
    const headless = meta?.source === 'exec' || meta?.originator === 'codex_exec';
    if (meta && !headless && (meta.cwd === cwd || safeReal(meta.cwd) === safeReal(cwd))) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
export function conversationFor(agent, cwd) {
  if (process.env.RELAY_NO_CONVERSATION === '1') return '';
  try {
    if (agent === 'claude') {
      const file = claudeTranscript(cwd);
      return file ? formatConversation(claudeMessages(file), 'claude') : '';
    }
    if (agent === 'codex') {
      const file = codexTranscript(cwd);
      return file ? formatConversation(codexMessages(file), 'codex') : '';
    }
  } catch {
    // transcript formats are internal; never let them break a handoff
  }
  return '';
}
