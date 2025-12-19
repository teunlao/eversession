import type { Command } from "commander";

import { runClaudeSessionStartHook } from "../integrations/claude/session-start.js";

export function registerSessionStartCommand(program: Command): void {
  program
    .command("session-start")
    .description("Claude Code hook helper: log session start/resume to the EverSession session log")
    .action(async () => {
      await runClaudeSessionStartHook();
    });
}
