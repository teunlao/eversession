import type { Command } from "commander";

import { BRAND } from "../core/brand.js";
import { runClaudeReloadCommand } from "../integrations/claude/reload.js";
import { readClaudeSupervisorEnv } from "../integrations/claude/supervisor-control.js";
import { runCodexReloadCommand } from "../integrations/codex/reload.js";
import { readCodexSupervisorEnv } from "../integrations/codex/supervisor-control.js";

export function registerReloadCommand(program: Command): void {
  program
    .command("reload")
    .description("Request a reload from the running EVS supervisor (only available inside an evs claude/codex run)")
    .action(async () => {
      const claude = readClaudeSupervisorEnv();
      if (claude) {
        await runClaudeReloadCommand();
        return;
      }

      const codex = readCodexSupervisorEnv();
      if (codex) {
        await runCodexReloadCommand();
        return;
      }

      process.stderr.write(
        "error: `evs reload` is only available inside an EverSession supervisor.\n" +
          `Expected env vars: ${BRAND.env.claude.controlDir}/${BRAND.env.claude.runId} or ${BRAND.env.codex.controlDir}/${BRAND.env.codex.runId}.\n`,
      );
      process.exitCode = 1;
    });
}
