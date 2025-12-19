import type { Command } from "commander";

import { runClaudeReloadCommand } from "../integrations/claude/reload.js";

export function registerReloadCommand(program: Command): void {
  program
    .command("reload")
    .description("Request a Claude session reload (supervised) or print manual reload instructions")
    .argument("[sessionId]", "explicit session id (uuid) for manual reload instructions")
    .action(async (sessionIdArg: string | undefined) => {
      await runClaudeReloadCommand(sessionIdArg);
    });
}
