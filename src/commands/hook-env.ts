import type { Command } from "commander";

import { runClaudeHookEnvCommand } from "../integrations/claude/hook-env.js";

export function registerHookEnvCommand(program: Command): void {
  program
    .command("hook-env")
    .description("Claude Code hook helper: export transcript_path to CLAUDE_ENV_FILE for bash mode")
    .action(async () => {
      await runClaudeHookEnvCommand();
    });
}
