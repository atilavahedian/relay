// Adapters: how to run each agent CLI headlessly, stream what it is doing, and read its answer.
// Relay drives the real CLIs, so it uses your existing logins and subscriptions.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './store.js';

const PROMPT = '{prompt}';

export const depth = () => Number(process.env.RELAY_DEPTH || 0);
export const maxDepth = () => Number(process.env.RELAY_MAX_DEPTH || 1);

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function lastJson(out) {
  const text = out.trim();
  try {
    return JSON.parse(text);
  } catch {
    // some CLIs print logs before the JSON; take the last line that parses
  }
  for (const line of text.split('\n').reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return null;
}

const short = (s, n = 140) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');

// ---------------------------------------------------------------------------
// Claude Code
//
// Handoffs run with edits auto-accepted and Bash inside Claude Code's OS sandbox
// (writes limited to the project, like Codex's workspace-write), so Claude can run
// tests and builds headlessly. Common build/test commands are also allow-listed so
// they still work where the sandbox is unavailable.
const CLAUDE_SANDBOX = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [
        'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
        'proxy.golang.org', 'sum.golang.org', 'crates.io', 'index.crates.io', 'static.crates.io',
        'github.com', 'codeload.github.com', 'objects.githubusercontent.com',
      ],
    },
  },
};
const READ_ONLY_BASH = ['git status', 'git diff', 'git log', 'git show', 'git blame', 'git branch', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'tree', 'pwd'];
const BUILD_BASH = [
  'npm test', 'npm run', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'uv run', 'ruff', 'mypy', 'go test', 'go build', 'go vet',
  'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'make', 'swift test', 'swift build', 'mvn test', 'gradle test',
  'git add', 'git status', 'git diff', 'git log', 'git show', 'mkdir', 'touch', 'ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc',
];
const bashRules = (cmds) => cmds.map((c) => `Bash(${c}:*)`);

function claudeToolLine(block) {
  const input = block.input || {};
  const target = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? '';
  return `${block.name}(${short(target, 110)})`;
}

const claude = {
  label: 'Claude Code',
  bin: 'claude',
  resumeCommand: (id) => `claude --resume ${id}`,
  args({ readOnly, session, newSessionId }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (session) args.push('--resume', session);
    else if (newSessionId) args.push('--session-id', newSessionId);
    if (readOnly) {
      args.push('--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit', '--allowedTools', ...bashRules(READ_ONLY_BASH));
    } else {
      args.push('--permission-mode', 'acceptEdits');
      // Claude Code's sandbox runs on macOS and Linux/WSL2; on native Windows the allow-list applies alone.
      if (process.platform !== 'win32') args.push('--settings', JSON.stringify(CLAUDE_SANDBOX));
      args.push('--allowedTools', ...bashRules(BUILD_BASH));
    }
    return args;
  },
  onLine(line, st, log) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.session_id) st.session = ev.session_id;
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          st.texts.push(block.text);
          log(`⏺ ${short(block.text, 400)}`);
        } else if (block.type === 'tool_use') {
          log(`⏺ ${claudeToolLine(block)}`);
        }
      }
    } else if (ev.type === 'user') {
      for (const block of ev.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : block.content;
        log(`  ⎿  ${block.is_error ? 'error: ' : ''}${short(text, 160)}`);
      }
    } else if (ev.type === 'result') {
      st.final = ev.result;
      if (ev.is_error) st.error = ev.result || `Claude Code stopped (${ev.subtype || 'error'})`;
    }
  },
  finish(st, stdout) {
    if (!st.final && !st.texts.length) {
      // older versions or --output-format json
      const json = lastJson(stdout);
      if (json?.type === 'result' || json?.result !== undefined) {
        if (json.is_error) throw new Error(json.result || 'Claude Code returned an error');
        return { text: json.result ?? '', session: json.session_id || st.session };
      }
    }
    if (st.error && !st.texts.length) throw new Error(st.error);
    return { text: st.final ?? st.texts.at(-1) ?? '', session: st.session };
  },
  // kept for tests and the non-streaming fallback
  parse(out) {
    const json = lastJson(out);
    if (!json) return { text: out.trim() };
    if (json.is_error) throw new Error(json.result || 'Claude Code returned an error');
    return { text: json.result ?? '', session: json.session_id };
  },
};

// ---------------------------------------------------------------------------
// Codex
const codex = {
  label: 'Codex',
  bin: 'codex',
  resumeCommand: (id) => `codex resume ${id}`,
  args({ readOnly, session }) {
    const opts = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${readOnly ? 'read-only' : 'workspace-write'}"`];
    // Tell the child's own relay server it is nested, so it cannot hand work back in a loop.
    try {
      if (fs.readFileSync(codexConfig(), 'utf8').includes('[mcp_servers.relay]')) {
        opts.push('-c', `mcp_servers.relay.env.RELAY_DEPTH="${depth() + 1}"`);
      }
    } catch {}
    return session ? ['exec', 'resume', ...opts, session, '-'] : ['exec', ...opts, '-'];
  },
  onLine(line, st, log) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const item = ev.item || {};
    if (ev.type === 'thread.started') st.session = ev.thread_id;
    else if (ev.type === 'turn.failed') st.error = ev.error?.message || 'Codex turn failed';
    else if (ev.type === 'error') st.error = ev.message || 'Codex error';
    else if (ev.type === 'item.started' && item.type === 'command_execution') log(`• Running ${short(item.command, 140)}`);
    else if (ev.type === 'item.completed') {
      if (item.type === 'agent_message') {
        st.texts.push(item.text);
        log(`• ${short(item.text, 400)}`);
      } else if (item.type === 'command_execution') {
        const tail = short(String(item.aggregated_output || '').trim().split('\n').slice(-1)[0], 120);
        log(`  └ ${item.exit_code === 0 ? 'ok' : `exit ${item.exit_code}`}${tail ? `: ${tail}` : ''}`);
      } else if (item.type === 'file_change') {
        for (const c of item.changes || []) log(`• ${c.kind === 'add' ? 'Added' : c.kind === 'delete' ? 'Deleted' : 'Edited'} ${c.path}`);
      } else if (item.type === 'mcp_tool_call') log(`• Called ${item.server}.${item.tool}`);
      else if (item.type === 'web_search') log(`• Searched the web: ${short(item.query, 100)}`);
      else if (item.type === 'reasoning' && item.text) log(`  ${short(item.text, 160)}`);
    }
  },
  finish(st) {
    if (!st.texts.length && st.error) throw new Error(st.error);
    return { text: st.texts.at(-1) ?? '', session: st.session };
  },
  parse(out) {
    const st = { texts: [] };
    for (const line of out.split('\n')) codex.onLine(line, st, () => {});
    return codex.finish(st);
  },
};

// ---------------------------------------------------------------------------
// Gemini CLI
const gemini = {
  label: 'Gemini CLI',
  bin: 'gemini',
  resumeCommand: () => 'gemini --resume latest',
  args({ readOnly }) {
    return ['--output-format', 'json', '--approval-mode', readOnly ? 'default' : 'auto_edit', '-p', PROMPT];
  },
  parse(out) {
    const json = lastJson(out);
    if (!json) return { text: out.trim() };
    if (json.error) throw new Error(json.error.message || String(json.error));
    return { text: json.response ?? '', session: json.session_id };
  },
};

// ---------------------------------------------------------------------------
// Cursor Agent CLI
const cursor = {
  label: 'Cursor Agent',
  bin: 'cursor-agent',
  altBins: ['agent'],
  resumeCommand: (id) => `cursor-agent --resume ${id}`,
  args({ readOnly, session }) {
    const args = ['-p', '--output-format', 'stream-json'];
    if (session) args.push('--resume', session);
    if (!readOnly) args.push('--force');
    args.push(PROMPT);
    return args;
  },
  onLine(line, st, log) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.session_id) st.session = ev.session_id;
    if (ev.type === 'assistant') {
      const text = (ev.message?.content || []).map((c) => c.text || '').join('');
      if (text.trim()) {
        st.texts.push(text);
        log(`• ${short(text, 400)}`);
      }
    } else if (ev.type === 'tool_call' && ev.subtype === 'started') {
      const call = ev.tool_call || {};
      const name = Object.keys(call)[0] || 'tool';
      const args = call[name]?.args || {};
      log(`• ${name.replace(/ToolCall$/, '')} ${short(args.command ?? args.path ?? '', 110)}`);
    } else if (ev.type === 'result') {
      st.final = ev.result;
      if (ev.is_error) st.error = ev.result || 'Cursor Agent returned an error';
    }
  },
  finish(st, stdout) {
    if (!st.final && !st.texts.length) {
      const json = lastJson(stdout);
      if (json) {
        if (json.is_error) throw new Error(json.result || 'Cursor Agent returned an error');
        return { text: json.result ?? '', session: json.session_id };
      }
      return { text: stdout.trim() };
    }
    if (st.error && !st.texts.length) throw new Error(st.error);
    return { text: st.final ?? st.texts.join('').trim(), session: st.session };
  },
  parse(out) {
    const json = lastJson(out);
    if (!json) return { text: out.trim() };
    if (json.is_error) throw new Error(json.result || 'Cursor Agent returned an error');
    return { text: json.result ?? '', session: json.session_id };
  },
};

export const BUILTIN = { claude, codex, gemini, cursor };

// Any other CLI can be added in ~/.relay/agents.json:
//   { "aider": { "command": ["aider", "--yes-always", "--message", "{prompt}"] } }
// Without a {prompt} placeholder the prompt is sent on stdin. Output is read as plain text.
function customAgents() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(home(), 'agents.json'), 'utf8'));
  } catch {
    return {};
  }
  const agents = {};
  for (const [name, def] of Object.entries(config)) {
    if (!Array.isArray(def?.command) || !def.command.length) continue;
    agents[name] = {
      label: def.label || name,
      bin: def.command[0],
      custom: true,
      args({ readOnly }) {
        const cmd = readOnly && Array.isArray(def.readOnlyCommand) ? def.readOnlyCommand : def.command;
        return cmd.slice(1);
      },
      onLine(line, st, log) {
        if (line.trim()) log(short(line, 200));
      },
      finish: (st, stdout) => ({ text: stdout.trim() }),
      parse: (out) => ({ text: out.trim() }),
    };
  }
  return agents;
}

export function allAgents() {
  return { ...BUILTIN, ...customAgents() };
}

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].concat(
  ['.local/bin', '.npm-global/bin', '.bun/bin', '.cargo/bin', '.volta/bin'].map((p) => path.join(os.homedir(), p)),
);

// Agents launched from desktop apps often get a minimal PATH, so search more widely.
export function searchPath() {
  const dirs = [process.env.RELAY_PATH, process.env.PATH, ...EXTRA_PATH]
    .filter(Boolean)
    .join(path.delimiter)
    .split(path.delimiter)
    .filter(Boolean);
  return [...new Set(dirs)].join(path.delimiter);
}

export function which(bin) {
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin) ? bin : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchPath().split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

export function binFor(agent) {
  for (const bin of [agent.bin, ...(agent.altBins || [])]) {
    const found = which(bin);
    if (found) return found;
  }
  return null;
}

export function available() {
  return Object.entries(allAgents())
    .filter(([, agent]) => binFor(agent))
    .map(([name]) => name);
}

function spawnOnce(name, agent, prompt, { cwd, readOnly, session, timeoutMs, onLog, onSession }) {
  const bin = binFor(agent);
  const extra = loadConfig()[name]?.args || [];
  // Agents that accept a preset session id get one, so the session can be opened while it runs.
  const newSessionId = session ? undefined : crypto.randomUUID();
  const rawArgs = [...agent.args({ readOnly, session, newSessionId }), ...extra];
  if (session || rawArgs.includes(newSessionId)) onSession?.(session || newSessionId);
  const viaArg = rawArgs.some((a) => a.includes(PROMPT));
  const args = rawArgs.map((a) => a.replaceAll(PROMPT, prompt));
  const log = onLog || (() => {});

  const env = { ...process.env, PATH: searchPath(), RELAY_DEPTH: String(depth() + 1) };
  // Don't let the child think it is running inside the parent agent's session.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const state = { texts: [] };
    let reported = session || (rawArgs.includes(newSessionId) ? newSessionId : undefined);
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    const started = Date.now();

    const feed = (chunk) => {
      stdout += chunk;
      if (!agent.onLine) return;
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          agent.onLine(line, state, log);
        } catch {}
        if (state.session && state.session !== reported) {
          reported = state.session;
          onSession?.(state.session);
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(viaArg ? '' : prompt);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending && agent.onLine) {
        try {
          agent.onLine(pending, state, log);
        } catch {}
      }
      if (timedOut) {
        const err = new Error(`${agent.label} timed out after ${Math.round(timeoutMs / 60000)} min`);
        err.timedOut = true;
        return reject(err);
      }
      let parsed;
      try {
        parsed = agent.finish ? agent.finish(state, stdout) : agent.parse(stdout);
      } catch (err) {
        return reject(err);
      }
      if (code !== 0 && !parsed.text) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-8).join('\n');
        return reject(new Error(`${agent.label} exited with code ${code}${detail ? `:\n${detail}` : ''}`));
      }
      resolve({ ...parsed, session: parsed.session || state.session, ms: Date.now() - started });
    });
  });
}

export async function run(name, prompt, opts = {}) {
  const agents = allAgents();
  const agent = agents[name];
  if (!agent) throw new Error(`Unknown agent "${name}". Known: ${Object.keys(agents).join(', ')}`);
  if (!binFor(agent)) throw new Error(`${agent.label} is not installed (no "${agent.bin}" on PATH).`);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.RELAY_TIMEOUT_MIN || 60) * 60000;
  const settings = { ...opts, timeoutMs };
  try {
    try {
      return await spawnOnce(name, agent, prompt, settings);
    } catch (err) {
      if (!opts.session || err.timedOut) throw err;
      // The saved session may be gone (deleted, other machine). Start fresh once.
      settings.onLog?.('(previous session unavailable, starting a new one)');
      return await spawnOnce(name, agent, prompt, { ...settings, session: undefined });
    }
  } catch (err) {
    if (/authenticat|log ?in|credential|unauthori[sz]ed|api key/i.test(err.message)) {
      err.message += `\nRun \`${agent.bin}\` once in a terminal to sign in, then try again.`;
    }
    throw err;
  }
}
