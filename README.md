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

`relay init` connects every agent on your machine. Restart open agent sessions. In Codex, run `/hooks` once and trust relay's hook.

## Use

Just ask, in plain words, inside any agent:

- *"hand the tests to codex"*: it does the work, edits files, runs the tests
- *"ask claude why this test is flaky"*: a second opinion; it won't touch files
- *"have codex review my changes"*: a review of your current diff
- *"…in the background"*: keep working; the result arrives with your next message

The other agent gets the task, your recent conversation, the branch, changed files, the diff (for reviews) and what other agents already did here. You never paste anything.

## See it, steer it

```bash
relay watch          # watch the other agent work, live
relay open codex     # continue that agent's session yourself, in its own app
relay jobs           # what's running and what finished
relay doctor         # what's connected and signed in
```

Your open agent windows stay in sync: each message you send includes what the other agents did since your last one. You also get a desktop notification when background work finishes.

## Why it works

- **Your existing logins.** relay runs the real CLIs, so there are no API keys and no extra bills.
- **Full-power, still safe.** Each agent keeps its own tools and sandbox. Claude runs commands inside its OS sandbox; Codex in `workspace-write`. Asks and reviews are read-only.
- **No loops.** An agent started by relay can't hand work on again.
- **Local and tiny.** Zero dependencies. Everything stays in `~/.relay`.

## Supported agents

| Agent | Calls relay | Receives work | Live sync |
|---|---|---|---|
| Claude Code | ✓ | ✓ | ✓ |
| Codex | ✓ | ✓ | ✓ |
| Gemini CLI | ✓ | ✓ | via replies |
| Cursor | ✓ | ✓ (`cursor-agent`) | via replies |
| Any CLI | | ✓ via `~/.relay/agents.json` | |

```json
{ "aider": { "command": ["aider", "--yes-always", "--message", "{prompt}"] } }
```

`relay uninstall` removes everything (configs were backed up as `*.relay-backup`). Requires Node 18+. MIT License.
