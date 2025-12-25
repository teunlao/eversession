import type { Command } from "commander";

import { deriveSessionIdFromPath } from "../core/paths.js";
import { readClaudeHookInputIfAny } from "../integrations/claude/hook-input.js";
import { buildClaudeInfoReport } from "../integrations/claude/info.js";

export function registerInfoCommand(program: Command): void {
  program
    .command("info", { hidden: true })
    .description("Internal: Claude Code hook helper (best-effort session introspection)")
    .option("--json", "print JSON to stdout")
    .action(async (opts: { json?: boolean }) => {
      try {
        const hook = await readClaudeHookInputIfAny(25);
        const transcriptPath = hook?.transcriptPath;
        if (!transcriptPath) return;

        const sessionId = hook?.sessionId ?? deriveSessionIdFromPath(transcriptPath);
        const res = await buildClaudeInfoReport({
          cwd: hook?.cwd ?? process.cwd(),
          sessionPath: transcriptPath,
          sessionId,
          isHookInvocation: true,
        });

        if (opts.json === true && res.ok) {
          process.stdout.write(JSON.stringify(res.report) + "\n");
        }
      } catch {
        // Never fail Claude hooks because of EVS introspection.
      }
    });
}

