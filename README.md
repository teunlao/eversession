# EverSession

**Say goodbye to Claude Code context limits.**  
Progressive session compaction keeps sessions under the limit without losing the thread.

EverSession is built around one idea:
**you should not have to manually run `/compact` or maintain a custom workflow to keep context relevant.**

## How it works (wireframe)

```text
Threshold = 100k tokens (Claude: /context → Messages)

   ┌──────────────────────────────────────────────────────────────┐
   │ EVS status (optional)                                        │
   │ Waiting 97k/100k  [███████▒]                                 │
   └──────────────────────────────────────────────────────────────┘
                 │ threshold reached
                 v
   ┌──────────────────────────────────────────────────────────────┐
   │ Auto-compact starts                                          │
   │ 102k/100k                                                    │
   └──────────────────────────────────────────────────────────────┘
                             │ next Stop hook
                             v
    
          │ supervised (auto mode)       │ unsupervised (manual mode)
          v                              v
   ┌─────────────────────────────┐   ┌────────────────────────────┐
   │ Auto reload + resume        │   │ Manual reload + resume     │
   │                             │   │   ! evs reload             │
   └─────────────────────────────┘   └────────────────────────────┘
             │                                   │
             │                                   │
             └───────────────┬───────────────────┘
                             │ reload boundary
                             v
   ┌──────────────────────────────────────────────────────────────┐
   │ Apply compact + resume                                       │
   │   102k → 78k  (summary + recent thread)                      │
   └──────────────────────────────────────────────────────────────┘
                        v
   ┌──────────────────────────────────────────────────────────────┐
   │ Keep working. No manual /compact.                            │
   └──────────────────────────────────────────────────────────────┘
```

## Why you want it

- **Automatic compaction** — keep sessions under the token budget without manual `/compact`.
- **Relevant context** — the thread stays coherent because EVS preserves structure and injects a summary.
- **Safe by default** — backups + atomic writes + locks/guards to avoid losing data.

Claude Code is the primary focus. Codex support is early/experimental.

## Install

Requirements: Node.js **>= 20**.

```bash
npm i -g eversession
evs --help
```

## Setup (recommended)

### 1) Install Claude Code hooks (project-local)

Run this in the project directory you use with Claude Code:

```bash
evs hooks install
```

This updates `<project>/.claude/settings.json`. Restart Claude Code after installing hooks.

Once hooks are installed, you can also run EVS commands inside Claude Code using bash mode, and omit the session id:

```bash
! evs log
! evs analyze
```

### 2) Run Claude Code under EVS supervisor (best experience)

```bash
evs claude --reload auto
```

If `claude` is not on your `PATH`, point EVS to the executable:

```bash
EVS_CLAUDE_BIN=/path/to/claude evs claude --reload auto
```

From here you just use Claude Code normally. EVS auto-compact triggers on `Stop` when you cross the configured token threshold.
In supervised mode it precomputes first and applies at the reload boundary.

### 3) Optional: install status line (nice UX)

```bash
evs statusline install
```

The status line is shown whenever it is configured in Claude settings. Restart Claude Code if needed.

## Why status line matters (beyond UI)

- It shows `current/threshold` so you can see when compaction is about to trigger.
- In supervised mode it can best-effort trigger background precompute early (so the pending compact is ready sooner).

## Why supervisor mode matters

- Applies compaction at the reload boundary (when Claude is not writing), reducing race risks.
- Enables `evs reload` to work as a real 1-command reload (instead of printing manual instructions).

## Configure auto-compact

EVS reads your config from the `Stop` hook command in `<project>/.claude/settings.json`.

The default hook installed by `evs hooks install` looks like this:

```json
{
  "type": "command",
  "command": "evs auto-compact start --threshold 140k --amount-tokens 40% --model haiku --busy-timeout 10s --notify",
  "timeout": 90
}
```

Change `--threshold`, `--amount-tokens`, and `--model` to match your workflow. Use `--amount-messages` for message-based removal.

## Token counting scope (important)

EVS targets Claude Code `/context → Messages` tokens (the visible message chain).  
It does not measure the full runtime/system context used by Claude Code.

## Codex (experimental)

### Project defaults (.evs/config.json)

To avoid repeating flags, create a project config (and edit it anytime):

```bash
evs config init
```

This writes `.evs/config.json`. Defaults (example):

```json
{
  "schemaVersion": 1,
  "codex": {
    "reload": "auto",
    "autoCompact": {
      "enabled": true,
      "threshold": "70%",
      "amountTokens": "40%",
      "model": "haiku",
      "busyTimeout": "10s"
    }
  }
}
```

Remove it anytime:

```bash
evs config remove
```

### Recommended: run Codex supervised (reload + safe apply)

```bash
evs codex
# or:
evs codex --reload auto
```

If `codex` is not on your `PATH`, point EVS to the executable:

```bash
EVS_CODEX_BIN=/path/to/codex evs codex --reload auto
```

Notes:

- `evs codex` launches Codex but injects the `notify` hook via `--config ...` (no edits to `~/.codex/config.toml`).
- Auto-compact is computed after turns and applied only at the reload boundary, then Codex resumes the same thread.

Manual reload (works in both Claude and Codex contexts):

```bash
evs reload
```

### Optional: install `notify` when running Codex directly

If you run Codex directly (without `evs codex`), install the notify hook once so EVS can resolve the active session:

```bash
evs codex install
# If you already have `notify = ...` configured:
evs codex install --force
# later:
evs codex uninstall
```

This edits `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) and adds/removes:

```toml
notify = ["evs", "codex", "notify"]
```

Restart Codex after install/uninstall for changes to take effect.

### Cleanup (optional)

- Forget Codex “current session” mapping: delete `~/.claude/.eversession/codex-state.json`
- Remove EVS logs/pending compacts for a Codex thread: delete `~/.claude/.eversession/sessions/<thread-id>/`

## Useful commands (later)

```bash
# Many commands accept an optional [id]. If you run EVS inside Claude Code
# (hooks / bash mode), EVS can often resolve the active session automatically.
# Outside Claude Code, pass an explicit UUID or a .jsonl path.

# Resolve the active session for this CWD
evs session

# Open the active transcript (or show the path)
evs open

# Show EVS auto-compact history (requires that EVS has already written a log)
evs log

# Analyze / validate / fix
evs analyze
evs validate
evs fix

# Manual compact
evs compact 25%

# Outside Claude Code examples
evs analyze /full/path/to/session.jsonl
evs compact /full/path/to/session.jsonl 25%
```

## Troubleshooting

### Status line not showing

- Run `evs statusline install` (or `--global` to install into `~/.claude/settings.json`).
- Restart Claude Code (the status line is shown when it is configured in settings).

### “Cannot determine current Claude session … (ambiguous)”

Pass an explicit session UUID or a `.jsonl` path:

```bash
evs open <uuid>
evs open /full/path/to/session.jsonl
```

### “Log not found”

EVS logs are created only after EVS writes events (e.g. `evs session-start`, `evs auto-compact ...`).  
`evs open --log` / `evs log` will not create a log file by themselves.

## Status

This project is early and evolving. Expect some sharp edges; safety defaults are intentional.
