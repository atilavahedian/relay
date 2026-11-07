// Builds the prompt the receiving agent sees: the task, plus the repo state and
// recent relay history, so nobody has to paste code or explain what happened.
import { execFileSync } from 'node:child_process';
import { clip, formatThread } from './store.js';

function git(cwd, args, max = 20000) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return clip(out.trim(), max);
  } catch {
    return '';
  }
}

export function projectRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
}

export function repoState(cwd, { fullDiff = false } = {}) {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return '';
  const parts = [`Branch: ${branch}`];
  const status = git(cwd, ['status', '--short'], 4000);
  if (status) parts.push(`Changed files:\n${status}`);
  const stat = git(cwd, ['diff', 'HEAD', '--stat'], 4000) || git(cwd, ['diff', '--stat'], 4000);
  if (stat) parts.push(`Diff stat:\n${stat}`);
  if (fullDiff) {
    const diff = git(cwd, ['diff', 'HEAD'], 80000) || git(cwd, ['diff'], 80000);
    parts.push(diff ? `Full diff:\n\`\`\`diff\n${diff}\n\`\`\`` : 'No uncommitted changes.');
  } else {
    const log = git(cwd, ['log', '--oneline', '-5'], 2000);
    if (log) parts.push(`Recent commits:\n${log}`);
  }
  return parts.join('\n\n');
}

const RULES = {
  handoff: 'You may read and edit files in this project to complete the task.',
  ask: 'Read-only: answer the question. Do not modify any files.',
  review: 'Read-only: review the changes. Do not modify any files.',
};

export function buildPrompt({ from, to, kind, task, context, cwd, root, history = [] }) {
  const sections = [
    `[relay] ${from} is handing this to you (${to}). Kind: ${kind}.`,
    `Project: ${root}${cwd !== root ? `\nWorking directory: ${cwd}` : ''}`,
    `## Task\n${task}`,
  ];
  if (context && context.trim()) sections.push(`## Context from ${from}\n${context.trim()}`);
  const state = repoState(cwd, { fullDiff: kind === 'review' });
  if (state) sections.push(`## Repo state\n${state}`);
  if (history.length) sections.push(`## Recent relay history in this project\n${formatThread(history, { max: 600 })}`);
  sections.push(
    `## Rules\n- ${RULES[kind]}\n- Your final message goes straight back to ${from}. End with a short summary: what you did or found, files changed, and anything left open.`,
  );
  return sections.join('\n\n');
}
