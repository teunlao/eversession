import type { Command } from "commander";

import { runClaudeStatuslineStatsCommand } from "../integrations/claude/statusline-stats.js";

export function registerStatuslineStatsCommand(program: Command): void {
  program
    .command("statusline-stats")
    .description("Analyze status line dump timings (.evs.statusline.stdin.jsonl)")
    .option("--path <file>", "path to dump file (default: <project>/.evs.statusline.stdin.jsonl)")
    .option("--tail <n>", "only analyze last N lines (default: 500)", "500")
    .option("--json", "output JSON")
    .action(async (opts: { path?: string; tail: string; json?: boolean }) => {
      await runClaudeStatuslineStatsCommand(opts);
    });
}
