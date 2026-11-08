// The tools every connected agent sees: handoff, ask, review, status, thread, note.
import { allAgents, available, depth, maxDepth } from './agents.js';
import { buildPrompt, projectRoot } from './context.js';
import * as jobs from './jobs.js';
import * as store from './store.js';
import { conversationFor } from './transcripts.js';

export const INSTRUCTIONS =
  'relay connects you to the other coding agents on this machine (Claude Code, Codex, Gemini CLI, Cursor). ' +
  'Use `handoff` to delegate work, `ask` for a second opinion, and `review` to get the current changes reviewed by another agent. ' +
  'The task, repo state, your recent conversation with the user and the shared relay history are attached automatically, ' +
  'so never ask the user to copy-paste between agents. When another agent disagrees with you, surface it to the user instead of quietly overruling it. For long tasks pass background: true and keep working; ' +
  'results come back in later relay replies or via `status`. Use `thread` to see what other agents did here, and `note` to leave a decision for them.';

const KINDS = ['handoff', 'ask', 'review'];
const DEFAULT_WAIT_SEC = Number(process.env.RELAY_WAIT_SEC || 600);

const fmtDuration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

export function resolveCwd(cwd) {
  return cwd || process.env.RELAY_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function describeResult(job) {
  if (job.status === 'failed') return `${job.to} failed (job ${job.id}): ${job.error}`;
  const hint = jobs.resumeHint(job);
  const footer = [`job ${job.id}`, hint && `continue it yourself: \`${hint}\`${job.cwd ? ` in ${job.cwd}` : ''}`].filter(Boolean).join(' · ');
  return `${job.to} replied after ${fmtDuration(job.ms || 0)}:\n\n${job.result || '(empty reply)'}\n\n— ${footer}\n\n${disagreementRule(job)}`;
}

// One agent must never quietly overrule the other: agreement can be acted on,
// disagreement goes to the user.
export function disagreementRule(job) {
  const what = job.kind === 'handoff' ? `${job.to}'s work` : `${job.to}'s ${job.kind === 'review' ? 'review' : 'answer'}`;
  return (
    `[relay] ${what} is input, not a decision. Act on the points you agree with. ` +
    `If you disagree with any point, or won't act on it, do not drop it silently: tell the user what ${job.to} said, ` +
    `why you disagree, and let them decide. Then record the outcome with the relay note tool.`
  );
}

function describeRunning(job) {
  const last = jobs.lastLogLine(job.id);
  return (
    `${job.to} is working on it in the background (job ${job.id}${job.agentSession ? `, session ${job.agentSession}` : ''}).\n` +
    (last ? `Latest: ${last}\n` : '') +
    `Keep going with other work. The result will be included in your next relay reply, or call status with job "${job.id}" (and wait) when you need it. ` +
    `The user can watch live with: relay watch ${job.id}`
  );
}

export function createTools(self = 'agent') {
  const cwdProp = { type: 'string', description: 'Absolute path of the project. Defaults to the current project.' };
  const bgProp = {
    type: 'boolean',
    description: 'Return immediately and let the agent work in the background. Use for anything that may take more than a few minutes.',
  };

  function targetProp() {
    const names = available();
    return {
      type: 'string',
      ...(names.length ? { enum: names } : {}),
      description: `Agent to send this to. Installed: ${names.join(', ') || 'none found'}. You are ${self}.`,
    };
  }

  function listTools() {
    const tools = [];
    if (depth() < maxDepth()) {
      const to = targetProp();
      tools.push(
        {
          name: 'handoff',
          description:
            'Hand a task to another coding agent. It works in this same project, can edit files and run tests, and its final reply comes back to you. ' +
            'The repo state, your recent conversation with the user and relay history are attached automatically. Follow-ups to the same agent continue its previous session.',
          inputSchema: {
            type: 'object',
            properties: {
              to,
              task: { type: 'string', description: 'What the other agent should do, including what "done" looks like.' },
              context: { type: 'string', description: 'Anything it needs that is not in the repo or the conversation: decisions, constraints, error output.' },
              background: bgProp,
              cwd: cwdProp,
              fresh: { type: 'boolean', description: 'Start a new session instead of continuing the last one with this agent.' },
            },
            required: ['to', 'task'],
          },
        },
        {
          name: 'ask',
          description: 'Ask another coding agent a question about this project (read-only; it will not edit files). Good for second opinions and debugging help.',
          inputSchema: {
            type: 'object',
            properties: {
              to,
              question: { type: 'string', description: 'The question.' },
              context: { type: 'string', description: 'Optional extra context: errors, logs, what you already tried.' },
              background: bgProp,
              cwd: cwdProp,
              fresh: { type: 'boolean', description: 'Start a new session instead of continuing the last one.' },
            },
            required: ['to', 'question'],
          },
        },
        {
          name: 'review',
          description: 'Have another coding agent review the current uncommitted changes (the full diff is attached). Read-only.',
          inputSchema: {
            type: 'object',
            properties: {
              to,
              focus: { type: 'string', description: 'Optional: what to focus on (security, edge cases, performance…).' },
              background: bgProp,
              cwd: cwdProp,
            },
            required: ['to'],
          },
        },
        {
          name: 'status',
          description: 'Check on work you handed to other agents. Without "job": lists recent relay jobs in this project. With "job": that job\'s status or result, optionally waiting for it to finish.',
          inputSchema: {
            type: 'object',
            properties: {
              job: { type: 'string', description: 'Job id returned by handoff/ask/review.' },
              wait: { type: 'number', description: 'Seconds to wait for the job to finish (default 0).' },
              cwd: cwdProp,
            },
          },
        },
      );
    }
    tools.push(
      {
        name: 'thread',
        description: 'Read the shared relay history for this project: every handoff, question, review and note between agents.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many recent entries (default 10).' }, cwd: cwdProp },
        },
      },
      {
        name: 'note',
        description: 'Leave a note in the shared relay history (a decision, a plan, a warning) for the other agents to see.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The note.' }, cwd: cwdProp },
          required: ['text'],
        },
      },
    );
    return tools;
  }

  async function delegate(kind, args, progress) {
    if (depth() >= maxDepth()) throw new Error('This agent was itself started by relay; nested handoffs are disabled to avoid loops.');
    const to = args.to;
    if (!to) throw new Error('Missing "to": which agent should get this?');
    if (!allAgents()[to]) throw new Error(`Unknown agent "${to}". Installed: ${available().join(', ') || 'none'}`);

    const cwd = resolveCwd(args.cwd);
    const root = projectRoot(cwd);
    let task = kind === 'ask' ? args.question : args.task;
    if (kind === 'review') {
      task =
        `Review the current uncommitted changes in this project${args.focus ? `, focusing on: ${args.focus}` : ''}. ` +
        'List concrete issues most severe first (file:line, why it matters, suggested fix). Say plainly if it looks good.';
    }
    if (!task) throw new Error(kind === 'ask' ? 'Missing "question".' : 'Missing "task".');

    const readOnly = kind !== 'handoff';
    const saved = args.fresh || kind === 'review' ? undefined : store.getSessionInfo(root, to);
    // Some agents (Cursor) keep a conversation's read-only/write mode for good: only resume a
    // session whose mode matches, otherwise start a fresh one.
    const modeMatches = !allAgents()[to].stickyMode || (typeof saved?.readOnly === 'boolean' && saved.readOnly === readOnly);
    const session = saved && modeMatches ? saved.id : undefined;
    const conversation = args.conversation === false ? '' : conversationFor(self, cwd);
    const prompt = buildPrompt({ from: self, to, kind, task, context: args.context, conversation, cwd, root, history: store.read(root, 6) });

    const job = jobs.start(jobs.create({ from: self, to, kind, task, prompt, cwd, root, readOnly, session }));
    const waitSec = args.background ? 0 : Number(args.wait ?? DEFAULT_WAIT_SEC);
    const done = await jobs.wait(job.id, {
      timeoutMs: Math.max(0, waitSec) * 1000,
      onTick: (j, last) => progress?.(Date.now() - Date.parse(j.createdAt), last),
    });
    if (!jobs.isDone(done)) return describeRunning(done || job);
    jobs.markDelivered(done.id);
    if (done.status === 'failed') throw new Error(`${to} failed (job ${done.id}): ${done.error}`);
    return describeResult(done);
  }

  async function status(args) {
    const root = projectRoot(resolveCwd(args.cwd));
    if (!args.job) {
      const recent = jobs.list({ root, limit: 10 });
      if (!recent.length) return 'No relay jobs in this project yet.';
      return recent
        .map((j) => {
          const age = fmtDuration(Date.now() - Date.parse(j.createdAt));
          const tail = jobs.isDone(j) ? (j.status === 'failed' ? `failed: ${j.error}` : store.clip(j.result, 160)) : jobs.lastLogLine(j.id);
          return `${j.id}  ${j.from} → ${j.to} (${j.kind})  ${j.status}, ${age} ago\n  ${store.clip(tail, 200)}`;
        })
        .join('\n');
    }
    const job = await jobs.wait(args.job, { timeoutMs: Math.max(0, Number(args.wait) || 0) * 1000 });
    if (!job) throw new Error(`No relay job "${args.job}".`);
    if (!jobs.isDone(job)) return describeRunning(job);
    jobs.markDelivered(job.id);
    return describeResult(job);
  }

  // Results of background jobs ride along on the next relay reply, so the agent never misses them.
  function withInbox(text, cwd) {
    const root = projectRoot(resolveCwd(cwd));
    const finished = jobs.undelivered(self, root);
    if (!finished.length) return text;
    const parts = finished.map((j) => {
      jobs.markDelivered(j.id);
      return describeResult(j);
    });
    return `${text}\n\n📬 Finished in the background since you last checked:\n\n${parts.join('\n\n')}`;
  }

  async function callTool(name, args = {}, { progress } = {}) {
    let text;
    if (KINDS.includes(name)) text = await delegate(name, args, progress);
    else if (name === 'status') text = await status(args);
    else if (name === 'thread') {
      const root = projectRoot(resolveCwd(args.cwd));
      text = store.formatThread(store.read(root, Math.max(1, Math.min(Number(args.limit) || 10, 100))));
    } else if (name === 'note') {
      if (!args.text) throw new Error('Missing "text".');
      store.append(projectRoot(resolveCwd(args.cwd)), { from: self, kind: 'note', text: store.clip(args.text, 8000) });
      text = 'Noted in the relay thread.';
    } else throw new Error(`Unknown tool: ${name}`);
    return withInbox(text, args.cwd);
  }

  return { listTools, callTool };
}
