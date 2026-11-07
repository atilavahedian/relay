# relay

**Stop copy-pasting between coding agents.**

Claude Code, Codex, Gemini CLI and Cursor hand work to each other directly, in the same repo, with the context attached.

```
You (in Claude Code):  ask codex to review this
Claude → relay → Codex reads the diff, reviews it, replies
Claude:                Codex found 2 issues. Fixing the first one…
```

**[Website](https://atilavahedian.github.io/relay/)**

## Install

```bash
npm install -g github:atilavahedian/relay
relay init
```

`relay init` finds every agent on your machine and connects them. Restart any open agent sessions. That's it.

## Use

Just ask, in plain words, inside any agent:

- *"hand the tests to codex"*: the other agent does the work and edits files
- *"ask claude why this test is flaky"*: a second opinion; it won't touch files
- *"have codex review my changes"*: a review of your current diff
- *"what did the other agents do here?"*: the shared history

You never paste code. Relay attaches the task, the branch, the changed files, the diff (for reviews) and recent history automatically. Follow-ups to the same agent continue its previous session, so it remembers.

The same works from your terminal:

```bash
relay review codex
relay ask claude "is this migration safe?"
relay handoff codex "add tests for src/auth.ts"
relay thread
```

## Why it works

- **Uses your existing logins.** Relay runs the real CLIs (`claude`, `codex`, `gemini`, `cursor-agent`), so there are no API keys and no extra bills.
- **Full-power agents.** The agent receiving the task keeps its own tools, sandbox and repo access.
- **No loops.** An agent started by relay can't hand work back again.
- **Zero dependencies.** One small Node package. Data stays local in `~/.relay`.

## Supported agents

| Agent | Can call relay | Can receive work |
|---|---|---|
| Claude Code | ✓ | ✓ |
| Codex | ✓ | ✓ |
| Gemini CLI | ✓ | ✓ |
| Cursor | ✓ | ✓ (with `cursor-agent`) |
| Anything else | | ✓ via `~/.relay/agents.json` |

Add any other CLI agent:

```json
{ "aider": { "command": ["aider", "--yes-always", "--message", "{prompt}"] } }
```

## More

`relay doctor` shows what's connected. `relay uninstall` removes relay from every agent (config files were backed up as `*.relay-backup`). The default timeout is 30 min (`RELAY_TIMEOUT_MIN`). Requires Node 18+.

MIT License
