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
   │                             │   │   restart manually         │
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

### Claude Code

Run this in the project directory you use with Claude Code (writes `<project>/.claude/settings.json`):

```bash
evs install --agent claude
```

Then run Claude under the EVS supervisor:

```bash
evs claude --reload auto
```

If `claude` isn’t on your `PATH`:

```bash
EVS_CLAUDE_BIN=/path/to/claude evs claude --reload auto
```

### Codex

Run Codex under the EVS supervisor:

```bash
evs codex --reload auto
```

If `codex` isn’t on your `PATH`:

```bash
EVS_CODEX_BIN=/path/to/codex evs codex --reload auto
```

If you run Codex directly (without `evs codex`), install the notify hook once:

```bash
evs install --agent codex
# If you already have notify configured:
evs install --agent codex --force
# later:
evs uninstall --agent codex
```

This edits `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) and adds/removes:

```toml
notify = ["evs", "codex", "notify"]
```

## Token counting scope (important)

EVS targets Claude Code `/context → Messages` tokens (the visible message chain).  
It does not measure the full runtime/system context used by Claude Code.

## Config

EVS reads config from:

- Global: `~/.evs/config.json`
- Local: `<project>/.evs/config.json` (deep-merged; local overrides global)

View the resolved config (plus diagnostics about where values come from):

```bash
evs config show
```

Minimal example:

```json
{
  "schemaVersion": 1,
  "backup": false,
  "claude": {
    "reload": "manual",
    "autoCompact": {
      "enabled": true,
      "threshold": "120k",
      "amountTokens": "40%",
      "amountMessages": "25%",
      "model": "haiku",
      "busyTimeout": "10s",
      "notify": false,
      "backup": false
    }
  },
  "codex": {
    "reload": "manual",
    "autoCompact": {
      "enabled": true,
      "threshold": "70%",
      "amountTokens": "40%",
      "amountMessages": "35%",
      "model": "haiku",
      "busyTimeout": "10s",
      "notify": false,
      "backup": false
    }
  }
}
```

Notes:
- Most users only need to tweak `threshold`, `amountTokens`, and `model`.
- Backups are opt-in: use `backup: true` (or per-agent `autoCompact.backup: true`), or `--backup` on write commands.

## Useful commands

Inside `evs claude` / `evs codex` (supervisor mode), you can omit the session ref:

```bash
evs session
evs log
evs analyze
evs lint --fix
evs compact
```

Outside the supervisor, pass an explicit ref (UUID or `.jsonl` path). Use `--agent claude|codex` only when a UUID is ambiguous:

```bash
evs session <ref>
evs log <ref>
evs compact <ref>
evs remove <ref> 10,11,12
evs fork <ref>
evs pin <name> <ref>
```

## Uninstall

Uninstall removes only EVS-installed integration artifacts (hooks/statusline/notify). It does not delete `~/.evs/config.json`.

```bash
evs uninstall --agent claude
evs uninstall --agent claude --global
evs uninstall --agent codex
```

## Troubleshooting

### Status line not showing

- Re-run `evs install --agent claude --statusline` (or add `--global` to use `~/.claude/settings.json`).
- Restart Claude Code.

### “Missing session …”

Outside the supervisor, pass an explicit session UUID or a `.jsonl` path:

```bash
evs session <uuid>
evs session /full/path/to/session.jsonl
```

### “Log not found”

EVS logs are created only after EVS writes events (e.g. auto-compact runs).  
`evs log` will not create a log file by itself.

## Status

This project is early and evolving. Expect some sharp edges; safety defaults are intentional.
