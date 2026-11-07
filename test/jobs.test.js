import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test gets its own relay home with a fake agent that sleeps a bit, logs, then answers.
function setup({ sleepMs = 50 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jobs-'));
  const relayHome = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(relayHome);
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  const fake = path.join(dir, 'slow-agent.mjs');
  fs.writeFileSync(
    fake,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('working on it');setTimeout(()=>{` +
      `const conv=s.includes('## Recent conversation');console.log('DONE conv='+conv)},${sleepMs})});`,
  );
  fs.writeFileSync(path.join(relayHome, 'agents.json'), JSON.stringify({ slow: { command: [process.execPath, fake] } }));
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_NOTIFY = '0';
  process.env.RELAY_DEPTH = '';
  return { dir, relayHome, project };
}

const load = async () => ({
  tools: await import('../src/tools.js'),
  jobs: await import('../src/jobs.js'),
  hooks: await import('../src/hooks.js'),
  store: await import('../src/store.js'),
  tr: await import('../src/transcripts.js'),
});

test('background handoff returns at once; result arrives via status and the inbox', async () => {
  const { project } = setup({ sleepMs: 600 });
  const { tools, jobs } = await load();
  const { callTool } = tools.createTools('claude');

  const reply = await callTool('handoff', { to: 'slow', task: 'do it', cwd: project, background: true });
  assert.match(reply, /working on it in the background \(job ([0-9a-f]{6})/);
  const id = /job ([0-9a-f]{6})/.exec(reply)[1];

  const done = await jobs.wait(id, { timeoutMs: 10000 });
  assert.equal(done.status, 'done');
  assert.match(done.result, /DONE/);
  assert.ok(fs.readFileSync(jobs.logFile(id), 'utf8').includes('working on it'), 'live log captured');

  // the next relay reply carries the finished result, exactly once
  const next = await callTool('thread', { cwd: project });
  assert.match(next, /Finished in the background/);
  assert.match(next, new RegExp(`job ${id}`));
  const again = await callTool('thread', { cwd: project });
  assert.doesNotMatch(again, /Finished in the background/);
});

test('blocking handoff waits for the result; status lists jobs', async () => {
  const { project } = setup();
  const { tools } = await load();
  const { callTool } = tools.createTools('codex');
  const reply = await callTool('ask', { to: 'slow', question: 'why?', cwd: project });
  assert.match(reply, /^slow replied after/);
  assert.match(reply, /DONE/);
  const list = await callTool('status', { cwd: project });
  assert.match(list, /codex → slow \(ask\)\s+done/);
});

test('hook catch-up: background results and other agents\' work reach the open session', async () => {
  const { project } = setup({ sleepMs: 100 });
  const { tools, jobs, hooks, store } = await load();

  // first message of a session just sets the cursor
  assert.equal(hooks.catchUp({ agent: 'claude', sessionId: 's1', cwd: project }), '');

  const reply = await tools.createTools('claude').callTool('review', { to: 'slow', cwd: project, background: true });
  const id = /job ([0-9a-f]{6})/.exec(reply)[1];
  await jobs.wait(id, { timeoutMs: 10000 });
  const { projectRoot } = await import('../src/context.js');
  store.append(projectRoot(project), { from: 'codex', kind: 'note', text: 'switched to vitest' });

  const injected = hooks.catchUp({ agent: 'claude', sessionId: 's1', cwd: project });
  assert.match(injected, /^\[relay\] Updates/);
  assert.match(injected, new RegExp(`job ${id}`));
  assert.match(injected, /codex noted:\n  switched to vitest/);
  assert.equal(hooks.catchUp({ agent: 'claude', sessionId: 's1', cwd: project }), '', 'nothing new the second time');

  const json = JSON.parse(hooks.claudeHook({ session_id: 's1', cwd: project, hook_event_name: 'UserPromptSubmit' }) || '{"none":1}');
  assert.ok(json.none, 'no output when nothing is new');
});

test('Claude transcript: recent user/assistant text, harness noise removed', async () => {
  const { dir, project } = setup();
  const { tr } = await load();
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>The login page breaks on Safari' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Looking at auth.ts now.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents' }] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ask codex to double check the cookie flags' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const conv = tr.formatConversation(tr.claudeMessages(file), 'claude');
  assert.equal(conv, 'user: The login page breaks on Safari\n\nclaude: Looking at auth.ts now.\n\nuser: ask codex to double check the cookie flags');

  // the hook remembers which transcript is live for this project
  tr.rememberLiveSession('claude', project, { transcript: file, sessionId: 's9' });
  assert.match(tr.conversationFor('claude', project), /cookie flags/);
});

test('Codex rollout: session meta and messages', async () => {
  const { dir } = setup();
  const { tr } = await load();
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'abc', cwd: '/x/app', originator: 'codex_cli_rs' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky test' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is a race in setup().' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(tr.codexMeta(file).cwd, '/x/app');
  assert.equal(tr.formatConversation(tr.codexMessages(file), 'codex'), 'user: fix the flaky test\n\ncodex: It is a race in setup().');
});

test('Claude stream-json adapter: live log lines, final result, session id', async () => {
  const { BUILTIN } = await import('../src/agents.js');
  const st = { texts: [] };
  const logs = [];
  const events = [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '18 passed' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All 18 tests pass.' }] } },
    { type: 'result', subtype: 'success', result: 'All 18 tests pass.', session_id: 'sess-1', is_error: false },
  ];
  for (const e of events) BUILTIN.claude.onLine(JSON.stringify(e), st, (l) => logs.push(l));
  assert.deepEqual(logs, ['⏺ Bash(npm test)', '  ⎿  18 passed', '⏺ All 18 tests pass.']);
  assert.deepEqual(BUILTIN.claude.finish(st, ''), { text: 'All 18 tests pass.', session: 'sess-1' });

  // signed-out runs report is_error on a "success" result: must surface as an error
  const bad = { texts: [] };
  for (const e of [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate' }] } },
    { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' },
  ]) BUILTIN.claude.onLine(JSON.stringify(e), bad, () => {});
  assert.throws(() => BUILTIN.claude.finish(bad, ''), /OAuth session expired/);

  const args = BUILTIN.claude.args({ readOnly: false, newSessionId: 'u-1' });
  assert.ok(args.includes('--session-id') && args.includes('u-1'));
  if (process.platform !== 'win32') assert.match(args[args.indexOf('--settings') + 1], /"autoAllowBashIfSandboxed":true/);
  assert.ok(args.includes('Bash(npm test:*)'));
});

test('Gemini stream-json (documented schema): deltas joined, tools logged, errors surfaced', async () => {
  const { BUILTIN } = await import('../src/agents.js');
  const g = BUILTIN.gemini;
  const st = { texts: [], cwd: '/p' };
  const logs = [];
  for (const e of [
    { type: 'init', session_id: 'g-1', model: 'gemini-x' },
    { type: 'message', role: 'user', content: 'task' },
    { type: 'message', role: 'assistant', content: 'Running the ', delta: true },
    { type: 'message', role: 'assistant', content: 'tests.', delta: true },
    { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't1', parameters: { command: 'npm test' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: '12 passing' },
    { type: 'message', role: 'assistant', content: 'All 12 pass.', delta: true },
    { type: 'result', status: 'success', stats: { tool_calls: 1 } },
  ]) g.onLine(JSON.stringify(e), st, (l) => logs.push(l));
  assert.deepEqual(logs, ['• Running the tests.', '• run_shell_command(npm test)', '  └ 12 passing', '• All 12 pass.']);
  assert.deepEqual(g.finish(st, ''), { text: 'Running the tests.\n\nAll 12 pass.', session: 'g-1' });

  const bad = { texts: [] };
  g.onLine(JSON.stringify({ type: 'result', status: 'error', error: { type: 'auth', message: 'Please sign in' } }), bad, () => {});
  assert.throws(() => g.finish(bad, ''), /Please sign in/);

  const ro = g.args({ readOnly: true });
  assert.deepEqual(ro.slice(0, 5), ['--output-format', 'stream-json', '--skip-trust', '--approval-mode', 'default']);
  assert.equal(g.args({ readOnly: false, session: 'g-1' }).includes('--resume'), true);
});

test('Cursor stream-json (documented schema) and flags', async () => {
  const { BUILTIN } = await import('../src/agents.js');
  const c = BUILTIN.cursor;
  const st = { texts: [], cwd: '/p' };
  const logs = [];
  for (const e of [
    { type: 'system', subtype: 'init', session_id: 'c-1', model: 'x' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the file.' }] }, session_id: 'c-1' },
    { type: 'tool_call', subtype: 'started', call_id: '1', tool_call: { readToolCall: { args: { path: '/p/src/a.ts' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: '1', tool_call: { readToolCall: { args: { path: '/p/src/a.ts' }, result: { success: { content: 'x' } } } } },
    { type: 'tool_call', subtype: 'started', call_id: '2', tool_call: { function: { name: 'grep', arguments: '{"q":"x"}' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'a.ts exports one function.', session_id: 'c-1' },
  ]) c.onLine(JSON.stringify(e), st, (l) => logs.push(l));
  assert.deepEqual(logs, ['• Reading the file.', '• read(src/a.ts)', '• grep({"q":"x"})']);
  assert.deepEqual(c.finish(st, ''), { text: 'a.ts exports one function.', session: 'c-1' });
  assert.ok(c.args({ readOnly: true }).join(' ').includes('--trust --mode ask'));
  assert.ok(c.args({ readOnly: false }).includes('--force'));
});
