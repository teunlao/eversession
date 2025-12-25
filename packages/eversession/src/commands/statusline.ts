import type { Command } from "commander";

import {
  runClaudeStatuslineCommand,
} from "../integrations/claude/statusline-command.js";

export function registerStatuslineCommand(program: Command): void {
  program
    .command("statusline", { hidden: true })
    .description("Internal: Claude Code status line command (reads stdin JSON, prints a single line)")
    .option(
      "--dump [path]",
      "append raw stdin payload to a JSONL file (default: <project>/.evs.statusline.stdin.jsonl)",
    )
    .option("--dump-env", "include selected env vars in dump output")
    .option("--timeout-ms <n>", "stdin read timeout in ms when no input is present (default: 50)", "50")
    .option("--max-bytes <n>", "max stdin bytes to read (default: 262144)", "262144")
    .action(async (opts: { dump?: string | true; dumpEnv?: boolean; timeoutMs: string; maxBytes: string }) => {
      await runClaudeStatuslineCommand(opts);
    });
}
