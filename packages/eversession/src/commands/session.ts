import type { Command } from "commander";

import { deriveSessionIdFromPath } from "../core/paths.js";
import { resolveSessionForCli } from "./session-ref.js";

export function registerSessionCommand(program: Command): void {
  program
    .command("session")
    .description("Show the current session (or resolve an explicit ref)")
    .argument("[ref]", "session id or .jsonl path (omit under evs supervisor)")
    .option("--agent <agent>", "claude|codex (optional; only needed when id is ambiguous)")
    .action(async (refArg: string | undefined, opts: { agent?: string }) => {
      const resolved = await resolveSessionForCli({ commandLabel: "session", refArg, agent: opts.agent });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }

      const id = deriveSessionIdFromPath(resolved.value.sessionPath);
      process.stdout.write(`agent: ${resolved.value.agent}\n`);
      process.stdout.write(`id: ${id}\n`);
      process.stdout.write(`path: ${resolved.value.sessionPath}\n`);
      process.exitCode = 0;
    });
}
