import type { Command } from "commander";

import { runSessionCommand } from "../integrations/session/command.js";

export function registerSessionCommand(program: Command): void {
  program
    .command("session")
    .description("Discover the session for the given CWD (Claude Code and/or Codex)")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--cwd <path>", "target working directory (default: process.cwd())")
    .option("--session-id <id>", "exact session id / conversation id to resolve (fast, most precise)")
    .option("--match <text>", "search candidate sessions by tail content (expensive)")
    .option("--fallback <on|off>", "Codex: allow global fallback outside this project (default: on). Claude: always off.", "on")
    .option("--lookback-days <n>", "Codex: how many days back to scan (default: 14)", "14")
    .option("--max-candidates <n>", "limit number of candidate files to inspect (default: 200)", "200")
    .option("--tail-lines <n>", "how many last JSONL lines to inspect (default: 500)", "500")
    .option("--claude-projects-dir <dir>", "override ~/.claude/projects (advanced)")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .option("--include-sidechains", "include agent-*.jsonl sidechains (Claude)")
    .option("--validate", "run parse+validate to report health")
    .option("--hook", "print a single-line hook-friendly status")
    .option("--json", "output JSON report")
    .action(async (opts) => {
      await runSessionCommand(opts);
    });
}
