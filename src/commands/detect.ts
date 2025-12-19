import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerDetectCommand(program: Command): void {
  program
    .command("detect")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option("--json", "output JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const resolved = await resolveSessionPathForCli({ commandLabel: "detect", idArg: id });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }
      const sessionPath = resolved.value.sessionPath;

      const result = await detectSession(sessionPath);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      if (result.agent === "unknown") {
        process.stdout.write(`unknown (confidence=${result.confidence})\n`);
        for (const note of result.notes) process.stdout.write(`- ${note}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`${result.agent} (${result.format}, confidence=${result.confidence})\n`);
    });
}
