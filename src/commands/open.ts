import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { readJsonlHead } from "../agents/session-discovery/shared.js";
import { fileExists } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { getLogPath } from "../integrations/claude/eversession-session-storage.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
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
    if (
      process.platform === "win32" &&
      code === "ENOENT" &&
      !bin.includes("\\") &&
      !bin.includes("/") &&
      !bin.endsWith(".cmd")
    ) {
      await attempt(`${bin}.cmd`);
      return;
    }
    throw err;
  }
}

type AgentChoice = "auto" | "claude" | "codex";

function isAgentChoice(value: string): value is AgentChoice {
  return value === "auto" || value === "claude" || value === "codex";
}

function looksLikeJsonlPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.endsWith(".jsonl") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".")
  );
}

function deriveCodexSessionIdFromTranscriptPath(transcriptPath: string): string | undefined {
  const base = path.basename(transcriptPath);
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

async function resolveCodexSessionIdFromTranscriptPath(transcriptPath: string): Promise<string | undefined> {
  const fromName = deriveCodexSessionIdFromTranscriptPath(transcriptPath);
  if (fromName) return fromName;

  try {
    const { jsonObjects } = await readJsonlHead(transcriptPath, 25);
    for (const obj of jsonObjects) {
      if (asString(obj.type) !== "session_meta") continue;
      const payload = obj.payload;
      if (!isJsonObject(payload)) continue;
      const id = asString(payload.id);
      if (id) return id;
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function resolveOpenSessionPath(params: {
  agent: AgentChoice;
  idArg: string | undefined;
  cwd: string;
  codexSessionsDir: string;
}): Promise<
  { agent: "claude" | "codex"; sessionPath: string; sessionId?: string }
  | { error: string; exitCode: number }
> {
  const idRaw = params.idArg?.trim();
  if (idRaw && looksLikeJsonlPath(idRaw)) {
    const resolvedPath = await resolveSessionPathForCli({
      commandLabel: "open",
      idArg: idRaw,
      cwd: params.cwd,
      allowDiscover: false,
    });
    if (!resolvedPath.ok) return { error: resolvedPath.error, exitCode: resolvedPath.exitCode };

    const detected = await detectSession(resolvedPath.value.sessionPath);
    if (detected.agent !== "claude" && detected.agent !== "codex") {
      return { error: "[evs open] Unsupported or unknown session format (expected Claude or Codex JSONL).", exitCode: 2 };
    }

    if (params.agent === "claude" && detected.agent !== "claude") {
      return { error: "[evs open] Expected a Claude session file. Re-run with --agent codex or omit --agent.", exitCode: 2 };
    }
    if (params.agent === "codex" && detected.agent !== "codex") {
      return { error: "[evs open] Expected a Codex session file. Re-run with --agent claude or omit --agent.", exitCode: 2 };
    }

    const sessionId =
      detected.agent === "codex" ? deriveCodexSessionIdFromTranscriptPath(resolvedPath.value.sessionPath) : undefined;
    return { agent: detected.agent, sessionPath: resolvedPath.value.sessionPath, ...(sessionId ? { sessionId } : {}) };
  }

  if (params.agent === "claude") {
    const resolved = await resolveSessionPathForCli({
      commandLabel: "open",
      idArg: params.idArg,
      cwd: params.cwd,
      allowDiscover: true,
    });
    if (!resolved.ok) return { error: resolved.error, exitCode: resolved.exitCode };
    return { agent: "claude", sessionPath: resolved.value.sessionPath };
  }

  if (params.agent === "codex") {
    const report = await discoverCodexSessionReport({
      cwd: params.cwd,
      codexSessionsDir: params.codexSessionsDir,
      fallback: true,
      lookbackDays: 14,
      maxCandidates: 200,
      tailLines: 500,
      validate: false,
      ...(params.idArg ? { sessionId: params.idArg } : {}),
    });
    if (report.agent === "unknown") return { error: "[evs open] No Codex session found for this cwd.", exitCode: 2 };
    if (report.confidence !== "high") {
      return {
        error: "[evs open] Cannot determine current Codex session with high confidence (ambiguous). Pass a session id.",
        exitCode: 2,
      };
    }
    const sessionId = report.session.id;
    return { agent: "codex", sessionPath: report.session.path, ...(sessionId ? { sessionId } : {}) };
  }

  // auto
  if (idRaw && idRaw.length > 0) {
    const claudeResolved = await resolveSessionPathForCli({
      commandLabel: "open",
      idArg: idRaw,
      cwd: params.cwd,
      allowDiscover: false,
    });

    const codexReport = await discoverCodexSessionReport({
      cwd: params.cwd,
      codexSessionsDir: params.codexSessionsDir,
      fallback: true,
      lookbackDays: 14,
      maxCandidates: 200,
      tailLines: 500,
      validate: false,
      sessionId: idRaw,
    });

    const claudePath = claudeResolved.ok ? claudeResolved.value.sessionPath : undefined;
    const codexPath =
      codexReport.agent === "codex" && codexReport.confidence === "high" ? codexReport.session.path : undefined;

    if (claudePath && codexPath) {
      return {
        error: "[evs open] Session id matches both Claude and Codex. Re-run with --agent claude|codex.",
        exitCode: 2,
      };
    }
    if (claudePath) return { agent: "claude", sessionPath: claudePath };
    if (codexPath) return { agent: "codex", sessionPath: codexPath, sessionId: idRaw };
  }

  // No id: prefer Claude only when there is explicit hook/env context.
  const claudeContext = await resolveSessionPathForCli({
    commandLabel: "open",
    cwd: params.cwd,
    allowDiscover: false,
  });
  if (claudeContext.ok) return { agent: "claude", sessionPath: claudeContext.value.sessionPath };

  const codex = await discoverCodexSessionReport({
    cwd: params.cwd,
    codexSessionsDir: params.codexSessionsDir,
    fallback: true,
    lookbackDays: 14,
    maxCandidates: 200,
    tailLines: 500,
    validate: false,
  });
  if (codex.agent !== "unknown" && codex.confidence === "high") {
    const sessionId = codex.session.id;
    return { agent: "codex", sessionPath: codex.session.path, ...(sessionId ? { sessionId } : {}) };
  }

  const claudeDiscover = await resolveSessionPathForCli({
    commandLabel: "open",
    cwd: params.cwd,
    allowDiscover: true,
  });
  if (claudeDiscover.ok) return { agent: "claude", sessionPath: claudeDiscover.value.sessionPath };

  return { error: "[evs open] No session found. Pass a .jsonl path or session id.", exitCode: 2 };
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Print (or open) the active session transcript (Claude Code or Codex)")
    .argument("[id]", "session id (UUID) or path to a .jsonl session file")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--ide [name]", "open file in an IDE (default: vscode when flag is provided)")
    .option("--log", "print/open the EverSession session log instead of the transcript")
    .option("--cwd <path>", "working directory for fallback discovery (default: process.cwd())")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .action(async (idArg: string | undefined, opts: { agent?: string; ide?: IdeFlag; log?: boolean; cwd?: string; codexSessionsDir?: string }) => {
      const ide = parseIdeFlag(opts.ide);

      const cwd = opts.cwd ?? process.cwd();
      const agentRaw = (opts.agent ?? "auto").trim();
      if (!isAgentChoice(agentRaw)) {
        process.stderr.write("[evs open] Invalid --agent value (expected auto|claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const resolved = await resolveOpenSessionPath({
        agent: agentRaw,
        idArg,
        cwd,
        codexSessionsDir: opts.codexSessionsDir ?? defaultCodexSessionsDir(),
      });
      if ("error" in resolved) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }

      const transcriptPath = resolved.sessionPath;
      let targetPath = transcriptPath;
      if (opts.log) {
        if (resolved.agent === "codex") {
          const sessionId = resolved.sessionId ?? (await resolveCodexSessionIdFromTranscriptPath(transcriptPath));
          if (!sessionId) {
            process.stderr.write("[evs open] Cannot determine Codex session id for --log. Pass a session id.\n");
            process.exitCode = 2;
            return;
          }
          const logPath = getLogPath(sessionId);
          if (!(await fileExists(logPath))) {
            process.stderr.write(`[evs open] Log not found (checked: EverSession central log).\n`);
            process.exitCode = 2;
            return;
          }
          targetPath = logPath;
        } else {
          const resolvedLog = await resolveClaudeSessionLogPath(transcriptPath);
          if (!resolvedLog) {
            const fallbackMsg = `Log not found (checked: ${transcriptPath}.evs.log and EverSession central log).\n`;
            process.stderr.write(`[evs open] ${fallbackMsg}`);
            process.exitCode = 2;
            return;
          }
          targetPath = resolvedLog.path;
        }
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
