import type { Command } from "commander";

import {
  runClaudeStatuslineCommand,
  runClaudeStatuslineInstall,
  runClaudeStatuslineUninstall,
} from "../integrations/claude/statusline-command.js";

export function registerStatuslineCommand(program: Command): void {
  const statuslineCmd = program
    .command("statusline")
    .description("Claude Code status line command (reads stdin JSON, prints a single line)")
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

  statuslineCmd
    .command("install")
    .description("Install EverSession status line into Claude settings")
    .option("-g, --global", "install into ~/.claude/settings.json instead of <project>/.claude/settings.json")
    .option("--force", "overwrite existing statusLine config")
    .action(async (cmdOpts: { global?: boolean; force?: boolean }) => {
      await runClaudeStatuslineInstall(cmdOpts);
    });

  statuslineCmd
    .command("uninstall")
    .description("Uninstall EverSession status line from Claude settings")
    .option("-g, --global", "uninstall from ~/.claude/settings.json instead of <project>/.claude/settings.json")
    .action(async (cmdOpts: { global?: boolean }) => {
      await runClaudeStatuslineUninstall(cmdOpts);
    });
}
