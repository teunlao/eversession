import type { Command } from "commander";

import * as fs from "node:fs/promises";

import { resolveClaudeSessionLogPath } from "../integrations/claude/log-paths.js";
import { formatClaudeAutoCompactLine, parseClaudeAutoCompactEntries } from "../integrations/claude/log.js";
import { resolveSessionPathForCli } from "./session-ref.js";


export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .alias("compact-log")
    .description("Show auto-compact history for the current Claude session")
    .argument("[id]", "session UUID or .jsonl path")
    .option("--tail <n>", "show last N auto-compact entries (default: 20)")
    .option("--all", "show all auto-compact entries")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .action(async (idArg: string | undefined, opts: { tail?: string; all?: boolean; cwd?: string }) => {
      const resolveArgs: { commandLabel: string; idArg?: string; cwd?: string } = { commandLabel: "log" };
      if (idArg) resolveArgs.idArg = idArg;
      if (opts.cwd) resolveArgs.cwd = opts.cwd;
      const resolved = await resolveSessionPathForCli(resolveArgs);
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }

      const sessionPath = resolved.value.sessionPath;
      const resolvedLog = await resolveClaudeSessionLogPath(sessionPath);
      if (!resolvedLog) {
        process.stderr.write(`[evs log] No log file found (checked: ${sessionPath}.evs.log and EverSession central log)\n`);
        process.exitCode = 2;
        return;
      }
      const { path: logPath } = resolvedLog;

      let raw: string;
      try {
        raw = await fs.readFile(logPath, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs log] Failed to read log: ${msg}\n`);
        process.exitCode = 2;
        return;
      }

      const entries = parseClaudeAutoCompactEntries(raw);

      if (entries.length === 0) {
        process.stdout.write("No auto-compact entries found.\n");
        return;
      }

      let tail = 20;
      if (opts.all) tail = entries.length;
      if (opts.tail !== undefined) {
        const parsed = Number.parseInt(opts.tail, 10);
        if (Number.isFinite(parsed) && parsed > 0) tail = parsed;
      }

      const slice = entries.slice(-tail);
      for (const entry of slice) {
        process.stdout.write(formatClaudeAutoCompactLine(entry) + "\n");
      }
    });
}
