import type { Command } from "commander";

import { runClaudeHookEnvCommand } from "../integrations/claude/hook-env.js";

export function registerHookEnvCommand(program: Command): void {
  program
    .command("hook-env", { hidden: true })
    .description("Internal: Claude Code hook helper (write env vars to CLAUDE_ENV_FILE)")
    .action(async () => {
      try {
        await runClaudeHookEnvCommand();
      } catch {
        // Never fail Claude hooks because of EVS env setup.
      }
    });
}
