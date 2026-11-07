// Adapters: how to run each agent CLI headlessly and read its answer back.
// Relay drives the real CLIs, so it uses your existing logins and subscriptions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './store.js';

const PROMPT = '{prompt}';

export const depth = () => Number(process.env.RELAY_DEPTH || 0);
export const maxDepth = () => Number(process.env.RELAY_MAX_DEPTH || 1);

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

const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');

export const BUILTIN = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    args({ readOnly, session }) {
      const args = ['-p', '--output-format', 'json'];
      if (session) args.push('--resume', session);
      if (readOnly) args.push('--disallowedTools', 'Edit,Write,NotebookEdit');
      else args.push('--permission-mode', 'acceptEdits');
      return args;
    },
    parse(out) {
      const json = lastJson(out);
      if (!json) return { text: out.trim() };
      if (json.is_error) throw new Error(json.result || 'Claude Code returned an error');
      return { text: json.result ?? '', session: json.session_id };
    },
  },

  codex: {
    label: 'Codex',
    bin: 'codex',
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
    parse(out) {
      let session;
      let error;
      const messages = [];
      for (const line of out.split('\n')) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'thread.started') session = event.thread_id;
        else if (event.type === 'item.completed' && event.item?.type === 'agent_message') messages.push(event.item.text);
        else if (event.type === 'turn.failed') error = event.error?.message || 'Codex turn failed';
        else if (event.type === 'error') error = event.message || 'Codex error';
      }
      if (!messages.length && error) throw new Error(error);
      return { text: messages.at(-1) ?? '', session };
    },
  },

  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    args({ readOnly }) {
      return ['--output-format', 'json', '--approval-mode', readOnly ? 'default' : 'auto_edit', '-p', PROMPT];
    },
    parse(out) {
      const json = lastJson(out);
      if (!json) return { text: out.trim() };
      if (json.error) throw new Error(json.error.message || String(json.error));
      return { text: json.response ?? '', session: json.session_id };
    },
  },

  cursor: {
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    args({ readOnly, session }) {
      const args = ['-p', '--output-format', 'json'];
      if (session) args.push('--resume', session);
      if (!readOnly) args.push('--force');
      args.push(PROMPT);
      return args;
    },
    parse(out) {
      const json = lastJson(out);
      if (!json) return { text: out.trim() };
      if (json.is_error) throw new Error(json.result || 'Cursor Agent returned an error');
      return { text: json.result ?? '', session: json.session_id };
    },
  },
};

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

export function available() {
  return Object.entries(allAgents())
    .filter(([, agent]) => which(agent.bin))
    .map(([name]) => name);
}

function spawnOnce(agent, prompt, { cwd, readOnly, session, timeoutMs, onTick }) {
  const bin = which(agent.bin);
  const rawArgs = agent.args({ readOnly, session });
  const viaArg = rawArgs.some((a) => a.includes(PROMPT));
  const args = rawArgs.map((a) => a.replaceAll(PROMPT, prompt));

  const env = { ...process.env, PATH: searchPath(), RELAY_DEPTH: String(depth() + 1) };
  // Don't let the child think it is running inside the parent agent's session.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const started = Date.now();

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(viaArg ? '' : prompt);

    const tick = onTick ? setInterval(() => onTick(Date.now() - started), 10000) : null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (tick) clearInterval(tick);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tick) clearInterval(tick);
      if (timedOut) {
        const err = new Error(`${agent.label} timed out after ${Math.round(timeoutMs / 60000)} min`);
        err.timedOut = true;
        return reject(err);
      }
      let parsed;
      try {
        parsed = agent.parse(stdout);
      } catch (err) {
        return reject(err);
      }
      if (code !== 0 && !parsed.text) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-8).join('\n');
        return reject(new Error(`${agent.label} exited with code ${code}${detail ? `:\n${detail}` : ''}`));
      }
      resolve({ ...parsed, ms: Date.now() - started });
    });
  });
}

export async function run(name, prompt, opts = {}) {
  const agents = allAgents();
  const agent = agents[name];
  if (!agent) throw new Error(`Unknown agent "${name}". Known: ${Object.keys(agents).join(', ')}`);
  if (!which(agent.bin)) throw new Error(`${agent.label} is not installed (no "${agent.bin}" on PATH).`);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.RELAY_TIMEOUT_MIN || 30) * 60000;
  const settings = { ...opts, timeoutMs };
  try {
    return await spawnOnce(agent, prompt, settings);
  } catch (err) {
    if (!opts.session || err.timedOut) throw err;
    // The saved session may be gone (deleted, other machine). Start fresh once.
    return spawnOnce(agent, prompt, { ...settings, session: undefined });
  }
}
