import type { Command } from "commander";

import { runClaudeSessionStartHook } from "../integrations/claude/session-start.js";

export function registerSessionStartCommand(program: Command): void {
  program
    .command("session-start", { hidden: true })
    .description("Internal: Claude Code hook helper (log session start/resume)")
    .action(async () => {
      await runClaudeSessionStartHook();
    });
}
