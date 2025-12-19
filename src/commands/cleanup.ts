import type { Command } from "commander";

import { runClaudeCleanupCommand } from "../integrations/claude/cleanup.js";

export function registerCleanupCommand(program: Command): void {
  program
    .command("cleanup")
    .description("Clean up old EverSession session data")
    .option("--max-age <days>", "Maximum age in days (default: 7)", "7")
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--list", "List all sessions with their age")
    .action(async (opts: { maxAge: string; dryRun?: boolean; list?: boolean }) => {
      await runClaudeCleanupCommand(opts);
    });
}
