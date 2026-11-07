// The tools every connected agent sees: handoff, ask, review, thread, note.
import { allAgents, available, depth, maxDepth, run } from './agents.js';
import { buildPrompt, projectRoot } from './context.js';
import * as store from './store.js';

export const INSTRUCTIONS =
  'relay connects you to the other coding agents on this machine (Claude Code, Codex, Gemini CLI, Cursor). ' +
  'Use `handoff` to delegate work, `ask` for a second opinion, and `review` to get the current changes reviewed by another agent. ' +
  'Repo state and the shared relay history are attached automatically, so never ask the user to copy-paste between agents. ' +
  'Use `thread` to see what other agents did in this project, and `note` to leave a decision for them.';

const KINDS = ['handoff', 'ask', 'review'];

const fmtDuration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);

export function createTools(self = 'agent') {
  const cwdProp = { type: 'string', description: 'Absolute path of the project. Defaults to the current project.' };

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
            'Hand a task to another coding agent. It works in this same project, can edit files, and its final reply comes back to you. ' +
            'Repo state and recent relay history are attached automatically. Follow-ups to the same agent continue its previous session.',
          inputSchema: {
            type: 'object',
            properties: {
              to,
              task: { type: 'string', description: 'What the other agent should do, including what "done" looks like.' },
              context: { type: 'string', description: 'Anything it needs that is not in the repo: decisions, constraints, error output.' },
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
              cwd: cwdProp,
            },
            required: ['to'],
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

    const cwd = args.cwd || process.cwd();
    const root = projectRoot(cwd);
    let task = kind === 'ask' ? args.question : args.task;
    if (kind === 'review') {
      task =
        `Review the current uncommitted changes in this project${args.focus ? `, focusing on: ${args.focus}` : ''}. ` +
        'List concrete issues most severe first (file:line, why it matters, suggested fix). Say plainly if it looks good.';
    }
    if (!task) throw new Error(kind === 'ask' ? 'Missing "question".' : 'Missing "task".');

    const session = args.fresh || kind === 'review' ? undefined : store.getSession(root, to);
    const prompt = buildPrompt({ from: self, to, kind, task, context: args.context, cwd, root, history: store.read(root, 6) });

    try {
      const res = await run(to, prompt, { cwd, readOnly: kind !== 'handoff', session, onTick: progress });
      if (res.session && kind !== 'review') store.setSession(root, to, res.session);
      store.append(root, { from: self, to, kind, task: store.clip(task, 4000), result: store.clip(res.text, 8000), session: res.session, ms: res.ms });
      return `${to} replied after ${fmtDuration(res.ms)}:\n\n${res.text || '(empty reply)'}`;
    } catch (err) {
      store.append(root, { from: self, to, kind, task: store.clip(task, 4000), error: err.message });
      throw err;
    }
  }

  async function callTool(name, args = {}, { progress } = {}) {
    if (KINDS.includes(name)) return delegate(name, args, progress);
    const root = projectRoot(args.cwd || process.cwd());
    if (name === 'thread') return store.formatThread(store.read(root, Math.max(1, Math.min(Number(args.limit) || 10, 100))));
    if (name === 'note') {
      if (!args.text) throw new Error('Missing "text".');
      store.append(root, { from: self, kind: 'note', text: store.clip(args.text, 8000) });
      return 'Noted in the relay thread.';
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  return { listTools, callTool };
}
