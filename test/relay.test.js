import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN } from '../src/agents.js';
import { removeTomlServer, tomlServerBlock } from '../src/install.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'relay.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  const relayHome = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(relayHome);
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  fs.writeFileSync(path.join(project, 'app.js'), 'console.log(1)\n');
  // A fake agent: echoes back the first line of the prompt and its nesting depth.
  const fake = path.join(dir, 'fake-agent.mjs');
  fs.writeFileSync(
    fake,
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('FAKE depth='+process.env.RELAY_DEPTH+' | '+s.split('\\n')[0]+' | has-task='+s.includes('## Task')+' | sees-file='+s.includes('app.js'))});",
  );
  fs.writeFileSync(path.join(relayHome, 'agents.json'), JSON.stringify({ fake: { command: [process.execPath, fake] } }));
  return { relayHome, project };
}

function mcpSession(env, cwd) {
  const child = spawn(process.execPath, [bin, 'serve', '--as', 'tester'], { env: { ...process.env, ...env }, cwd });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { request, close: () => child.kill() };
}

test('MCP: initialize, list tools, hand off to an agent, record the thread', async () => {
  const { relayHome, project } = sandbox();
  const s = mcpSession({ RELAY_HOME: relayHome, RELAY_DEPTH: '' }, project);
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'relay');
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['handoff', 'ask', 'review', 'thread', 'note']);
    assert.ok(list.result.tools[0].inputSchema.properties.to.enum.includes('fake'));

    const call = await s.request('tools/call', { name: 'handoff', arguments: { to: 'fake', task: 'write tests', cwd: project } });
    const text = call.result.content[0].text;
    assert.equal(call.result.isError, undefined);
    assert.match(text, /^fake replied after/);
    assert.match(text, /FAKE depth=1 \| \[relay\] tester is handing this to you \(fake\)/);
    assert.match(text, /has-task=true/);
    assert.match(text, /sees-file=true/);

    await s.request('tools/call', { name: 'note', arguments: { text: 'use vitest', cwd: project } });
    const thread = await s.request('tools/call', { name: 'thread', arguments: { cwd: project } });
    assert.match(thread.result.content[0].text, /tester → fake \(handoff\)/);
    assert.match(thread.result.content[0].text, /tester noted:\n  use vitest/);
  } finally {
    s.close();
  }
});

test('MCP: unknown agent is a tool error, not a crash', async () => {
  const { relayHome, project } = sandbox();
  const s = mcpSession({ RELAY_HOME: relayHome, RELAY_DEPTH: '' }, project);
  try {
    const call = await s.request('tools/call', { name: 'ask', arguments: { to: 'nobody', question: 'hi' } });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /Unknown agent "nobody"/);
    const ping = await s.request('ping', {});
    assert.deepEqual(ping.result, {});
  } finally {
    s.close();
  }
});

test('nested agents cannot hand off again (no loops)', async () => {
  const { relayHome, project } = sandbox();
  const s = mcpSession({ RELAY_HOME: relayHome, RELAY_DEPTH: '1' }, project);
  try {
    const list = await s.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['thread', 'note']);
  } finally {
    s.close();
  }
});

test('codex adapter reads the session id and final message from --json events', () => {
  const out = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done: 3 tests added"}}',
    '{"type":"turn.completed","usage":{}}',
  ].join('\n');
  assert.deepEqual(BUILTIN.codex.parse(out), { text: 'done: 3 tests added', session: 'abc-123' });
  assert.throws(() => BUILTIN.codex.parse('{"type":"turn.failed","error":{"message":"quota"}}'), /quota/);
  assert.deepEqual(BUILTIN.codex.args({ readOnly: true, session: 'abc' }).slice(0, 2), ['exec', 'resume']);
});

test('claude adapter reads result and session_id, surfaces errors', () => {
  assert.deepEqual(BUILTIN.claude.parse('{"type":"result","result":"ok","session_id":"s1","is_error":false}'), { text: 'ok', session: 's1' });
  assert.throws(() => BUILTIN.claude.parse('{"result":"Failed to authenticate","is_error":true}'), /authenticate/);
  assert.ok(BUILTIN.claude.args({ readOnly: true }).includes('--disallowedTools'));
  assert.ok(BUILTIN.claude.args({ readOnly: false }).includes('acceptEdits'));
});

test('codex TOML: relay block is replaced without touching other servers', () => {
  const original = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.other]',
    'command = "x"',
    '',
    '[mcp_servers.relay]',
    'command = "old"',
    '',
    '[mcp_servers.relay.env]',
    'RELAY_PATH = "old"',
    '',
    '[profiles.fast]',
    'model = "mini"',
    '',
  ].join('\n');
  const cleaned = removeTomlServer(original);
  assert.ok(!cleaned.includes('mcp_servers.relay'));
  assert.ok(cleaned.includes('[mcp_servers.other]') && cleaned.includes('[profiles.fast]') && cleaned.includes('model = "mini"'));
  const block = tomlServerBlock({ command: '/usr/bin/node', args: ['/r/relay.js', 'serve', '--as', 'codex'], env: { RELAY_PATH: '/bin' } });
  assert.match(block, /tool_timeout_sec = 3600/);
  assert.match(block, /args = \["\/r\/relay.js", "serve", "--as", "codex"\]/);
});

test('init writes Codex, Gemini and Cursor configs and uninstall removes them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n');
  // PATH without any agent CLIs, so only the config-dir targets are detected.
  const env = { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, '.codex'), PATH: path.dirname(process.execPath), RELAY_PATH: '' };
  const out = execFileSync(process.execPath, [bin, 'init'], { env, encoding: 'utf8' });
  assert.match(out, /✓ Codex/);
  assert.match(out, /✓ Cursor/);
  const toml = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.relay\]/);
  assert.ok(fs.existsSync(path.join(dir, '.codex', 'config.toml.relay-backup')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8')).mcpServers.relay);

  execFileSync(process.execPath, [bin, 'init'], { env }); // idempotent
  assert.equal(fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.relay\]/g).length, 1);

  execFileSync(process.execPath, [bin, 'uninstall'], { env });
  assert.ok(!fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8').includes('mcp_servers.relay'));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8')).mcpServers.relay);
});
