// Keeps the agent windows you have open in sync. Each time you send a message in an
// agent, its prompt hook asks relay "what happened in this project since I last looked?"
// and relay adds it to that message's context: finished background jobs, and work
// other agents did here.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './context.js';
import * as jobs from './jobs.js';
import * as store from './store.js';
import { rememberLiveSession } from './transcripts.js';
import { describeResult } from './tools.js';

const cursorsFile = () => path.join(store.home(), 'cursors.json');
const MAX_CONTEXT = 9000; // Claude Code caps injected context at 10k characters

function loadCursors() {
  try {
    return JSON.parse(fs.readFileSync(cursorsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveCursors(all) {
  fs.mkdirSync(store.home(), { recursive: true });
  fs.writeFileSync(cursorsFile(), JSON.stringify(all));
}

// Returns the text to inject, or '' when there is nothing new.
export function catchUp({ agent, sessionId, cwd, transcript }) {
  if (!cwd) return '';
  const root = projectRoot(cwd);
  if (transcript) {
    rememberLiveSession(agent, cwd, { transcript, sessionId });
    if (root !== cwd) rememberLiveSession(agent, root, { transcript, sessionId });
  }

  const cursors = loadCursors();
  const key = `${agent}:${sessionId || 'default'}:${store.projectKey(root)}`;
  const total = store.count(root);
  const seen = cursors[key];
  cursors[key] = total;
  saveCursors(cursors);

  const parts = [];
  // 1. Results of jobs this agent started in the background.
  for (const job of jobs.undelivered(agent, root)) {
    jobs.markDelivered(job.id);
    parts.push(describeResult(job));
  }
  // 2. What other agents did here since this session last looked (not on its first message).
  if (seen !== undefined && total > seen) {
    const others = store.readSince(root, seen).filter((e) => e.from !== agent && !(e.job && parts.some((p) => p.includes(`job ${e.job}`))));
    if (others.length) parts.push(`Activity from other agents in this project:\n${store.formatThread(others, { max: 1200 })}`);
  }
  // 3. Work still running.
  const running = jobs.list({ root, limit: 10 }).filter((j) => j.from === agent && !jobs.isDone(j));
  if (running.length) {
    parts.push(`Still running: ${running.map((j) => `job ${j.id} (${j.to}, ${j.kind}): ${jobs.lastLogLine(j.id) || 'starting'}`).join('; ')}`);
  }
  if (!parts.length) return '';
  return store.clip(`[relay] Updates from the other coding agents since your last message:\n\n${parts.join('\n\n')}`, MAX_CONTEXT);
}

// `relay hook claude|codex` — UserPromptSubmit hook. Both CLIs read the same JSON shape
// (Codex ignores plain stdout from this hook in practice, so always answer in JSON).
export function promptHook(agent, input) {
  const text = catchUp({ agent, sessionId: input.session_id, cwd: input.cwd, transcript: input.transcript_path });
  if (!text) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: text } });
}

export const claudeHook = (input) => promptHook('claude', input);
