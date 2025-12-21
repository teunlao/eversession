import type { Command } from "commander";

import { printIssuesHuman } from "../core/cli.js";
import { runReloadCommand } from "../integrations/reload.js";

export function registerReloadCommand(program: Command): void {
  program
    .command("reload")
    .description("Request a session reload (supervised) or print manual reload instructions")
    .argument("[sessionId]", "explicit session id (uuid) for manual reload instructions")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .action(async (sessionIdArg: string | undefined, opts: { agent?: string }) => {
      const agent = (opts.agent ?? "auto").trim();
      if (agent !== "auto" && agent !== "claude" && agent !== "codex") {
        printIssuesHuman([
          {
            severity: "error",
            code: "core.invalid_agent",
            message: `[Core] Invalid --agent value: ${opts.agent} (expected auto|claude|codex).`,
            location: { kind: "file", path: process.cwd() },
          },
        ]);
        process.exitCode = 2;
        return;
      }

      await runReloadCommand({ agent, ...(sessionIdArg ? { sessionIdArg } : {}) });
    });
}
