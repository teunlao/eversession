import type { Command } from "commander";

import { spawn } from "node:child_process";

import { resolveClaudeSessionLogPath } from "../integrations/claude/log-paths.js";
import { resolveSessionPathForCli } from "./session-ref.js";

type IdeFlag = string | true | undefined;

function hasErrorCode(err: unknown): err is { code: unknown } {
  return err !== null && typeof err === "object" && "code" in err;
}

function parseIdeFlag(ide: IdeFlag): string | undefined {
  if (ide === undefined) return undefined;
  if (ide === true) return "vscode";
  const trimmed = ide.trim();
  return trimmed.length > 0 ? trimmed : "vscode";
}

function ideBinary(ide: string): string {
  const normalized = ide.trim().toLowerCase();
  if (normalized === "vscode" || normalized === "code") return "code";
  return normalized;
}

async function openInIde(ide: string, filePath: string): Promise<void> {
  const bin = ideBinary(ide);
  const args = bin === "code" ? ["--reuse-window", filePath] : [filePath];
  await spawnDetached(bin, args);
}

async function spawnDetached(bin: string, args: string[]): Promise<void> {
  const attempt = async (exe: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, args, { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
    });
  };

  try {
    await attempt(bin);
  } catch (err) {
    const code = hasErrorCode(err) ? String(err.code) : undefined;
    if (process.platform === "win32" && code === "ENOENT" && !bin.includes("\\") && !bin.includes("/") && !bin.endsWith(".cmd")) {
      await attempt(`${bin}.cmd`);
      return;
    }
    throw err;
  }
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Print (or open) the active Claude Code session transcript")
    .argument("[id]", "Claude transcript UUID (filename) or path to a .jsonl session file")
    .option("--ide [name]", "open file in an IDE (default: vscode when flag is provided)")
    .option("--log", "print/open the EverSession session log instead of the transcript")
    .option("--cwd <path>", "working directory for fallback discovery (default: process.cwd())")
    .action(async (idArg: string | undefined, opts: { ide?: IdeFlag; log?: boolean; cwd?: string }) => {
      const ide = parseIdeFlag(opts.ide);

      const resolved = await resolveSessionPathForCli({
        commandLabel: "open",
        idArg,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      if (!resolved.ok) {
        process.stderr.write(`${resolved.error}\n`);
        process.exitCode = resolved.exitCode;
        return;
      }

      const transcriptPath = resolved.value.sessionPath;
      let targetPath = transcriptPath;
      if (opts.log) {
        const resolvedLog = await resolveClaudeSessionLogPath(transcriptPath);
        if (!resolvedLog) {
          const fallbackMsg = `Log not found (checked: ${transcriptPath}.evs.log and EverSession central log).\n`;
          process.stderr.write(`[evs open] ${fallbackMsg}`);
          process.exitCode = 2;
          return;
        }
        targetPath = resolvedLog.path;
      }

      process.stdout.write(`${targetPath}\n`);

      if (ide) {
        try {
          await openInIde(ide, targetPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[evs open] Failed to open in ide=${ide}: ${message}\n`);
          process.exitCode = 1;
        }
      }
    });
}
