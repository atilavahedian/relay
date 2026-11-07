// `relay init`: register relay as an MCP server in every agent found on this machine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, searchPath } from './agents.js';

const TIMEOUT_SEC = 3600;

export function serverCommand(as) {
  const script = fs.realpathSync(process.argv[1]);
  return { command: process.execPath, args: [script, 'serve', '--as', as], env: { RELAY_PATH: searchPath() } };
}

function backupOnce(file) {
  const backup = `${file}.relay-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; leaving it untouched.`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function jsonConfigTarget({ file, extra = {} }) {
  return {
    status: () => Boolean(readJson(file()).mcpServers?.relay),
    install(server) {
      const config = readJson(file());
      config.mcpServers = { ...config.mcpServers, relay: { ...server, ...extra } };
      writeJson(file(), config);
    },
    uninstall() {
      const config = readJson(file());
      if (!config.mcpServers?.relay) return;
      delete config.mcpServers.relay;
      writeJson(file(), config);
    },
  };
}

// --- Codex keeps its config in TOML. We only ever touch our own [mcp_servers.relay] tables.
export function removeTomlServer(text, name = 'relay') {
  const own = new RegExp(`^\\s*\\[mcp_servers\\.${name}(\\.[^\\]]+)?\\]\\s*$`);
  const anyHeader = /^\s*\[/;
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (anyHeader.test(line)) skipping = own.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function tomlServerBlock({ command, args, env }) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    '[mcp_servers.relay]',
    `command = ${q(command)}`,
    `args = [${args.map(q).join(', ')}]`,
    `tool_timeout_sec = ${TIMEOUT_SEC}`,
    'startup_timeout_sec = 30',
  ];
  if (env && Object.keys(env).length) {
    lines.push('', '[mcp_servers.relay.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`));
  }
  return lines.join('\n') + '\n';
}

const codexFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

const claudeJson = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');


// --- Prompt hooks: on every message you send in an open agent window, relay adds what the
// other agents did since your last message (finished background jobs, handoffs, notes).
export function hookCommand(agent) {
  const script = fs.realpathSync(process.argv[1]);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} hook ${agent}`;
}

const isRelayHook = (h) => typeof h?.command === 'string' && / hook (claude|codex)$/.test(h.command) && h.command.includes('relay');

// Works for both Claude Code settings.json and Codex hooks.json (same shape).
export function addPromptHook(config, agent) {
  const cleaned = removePromptHook(config);
  cleaned.hooks = cleaned.hooks || {};
  const list = cleaned.hooks.UserPromptSubmit || [];
  list.push({ hooks: [{ type: 'command', command: hookCommand(agent), timeout: 10 }] });
  cleaned.hooks.UserPromptSubmit = list;
  return cleaned;
}

export function removePromptHook(config) {
  const out = { ...config };
  const list = out.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return out;
  const kept = list
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isRelayHook(h)) }))
    .filter((group) => group.hooks.length);
  out.hooks = { ...out.hooks, UserPromptSubmit: kept };
  if (!kept.length) delete out.hooks.UserPromptSubmit;
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

const hasPromptHook = (config) => (config.hooks?.UserPromptSubmit || []).some((g) => (g.hooks || []).some(isRelayHook));

function hookFile(file, agent, note) {
  return {
    note,
    status: () => hasPromptHook(readJson(file())),
    install: () => writeJson(file(), addPromptHook(readJson(file()), agent)),
    uninstall() {
      if (!fs.existsSync(file())) return;
      const config = readJson(file());
      if (hasPromptHook(config)) writeJson(file(), removePromptHook(config));
    },
  };
}

const claudeSettings = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const codexHooks = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');

export const TARGETS = [
  {
    id: 'claude',
    label: 'Claude Code',
    detect: () => which('claude'),
    status: () => Boolean(readJson(claudeJson()).mcpServers?.relay),
    install(server) {
      const bin = which('claude');
      try {
        execFileSync(bin, ['mcp', 'remove', '-s', 'user', 'relay'], { stdio: 'ignore' });
      } catch {}
      const env = Object.entries(server.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      execFileSync(bin, ['mcp', 'add', '-s', 'user', 'relay', ...env, '--', server.command, ...server.args], { stdio: 'pipe' });
    },
    uninstall() {
      try {
        execFileSync(which('claude'), ['mcp', 'remove', '-s', 'user', 'relay'], { stdio: 'ignore' });
      } catch {}
    },
    hooks: hookFile(claudeSettings, 'claude', 'live sync on'),
  },
  {
    id: 'codex',
    label: 'Codex',
    detect: () => which('codex') || (fs.existsSync(path.dirname(codexFile())) ? path.dirname(codexFile()) : null),
    status: () => readText(codexFile()).includes('[mcp_servers.relay]'),
    install(server) {
      const file = codexFile();
      const current = removeTomlServer(readText(file)).replace(/\s*$/, '');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      backupOnce(file);
      fs.writeFileSync(file, (current ? current + '\n\n' : '') + tomlServerBlock(server));
    },
    uninstall() {
      const file = codexFile();
      if (!this.status()) return;
      fs.writeFileSync(file, removeTomlServer(readText(file)).replace(/\s*$/, '') + '\n');
    },
    // Codex runs a new hook only after you trust it once.
    hooks: hookFile(codexHooks, 'codex', 'live sync: in Codex, run /hooks once and trust the relay hook'),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: () => which('gemini') || (fs.existsSync(path.join(os.homedir(), '.gemini')) ? '~/.gemini' : null),
    ...jsonConfigTarget({ file: () => path.join(os.homedir(), '.gemini', 'settings.json'), extra: { timeout: TIMEOUT_SEC * 1000 } }),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: () => which('cursor-agent') || (fs.existsSync(path.join(os.homedir(), '.cursor')) ? '~/.cursor' : null),
    ...jsonConfigTarget({ file: () => path.join(os.homedir(), '.cursor', 'mcp.json'), extra: { type: 'stdio' } }),
  },
];

export function init() {
  const results = [];
  for (const target of TARGETS) {
    if (!target.detect()) {
      results.push({ target, state: 'missing' });
      continue;
    }
    try {
      target.install(serverCommand(target.id));
      let extras = '';
      if (target.hooks && process.env.RELAY_NO_HOOKS !== '1') {
        try {
          target.hooks.install();
          extras = target.hooks.note;
        } catch (err) {
          extras = `live sync not installed: ${err.message.split('\n')[0]}`;
        }
      }
      results.push({ target, state: 'connected', extras });
    } catch (err) {
      results.push({ target, state: 'error', error: err.message.split('\n')[0] });
    }
  }
  return results;
}

export function uninstall() {
  return TARGETS.map((target) => {
    try {
      target.uninstall();
      target.hooks?.uninstall();
      return { target, state: 'removed' };
    } catch (err) {
      return { target, state: 'error', error: err.message };
    }
  });
}

export function status() {
  return TARGETS.map((target) => {
    let connected = false;
    let synced = false;
    try {
      connected = target.status();
      synced = Boolean(target.hooks?.status());
    } catch {}
    const extras = target.hooks ? (synced ? 'live sync on' : 'live sync off: run `relay init`') : '';
    return { target, found: Boolean(target.detect()), connected, extras };
  });
}
