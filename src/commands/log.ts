import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Command } from "commander";
import { detectSession } from "../agents/detect.js";
import { readJsonlHead } from "../agents/session-discovery/shared.js";
import { fileExists } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { formatClaudeAutoCompactLine, parseClaudeAutoCompactEntries } from "../integrations/claude/log.js";
import { getLogPath } from "../integrations/claude/eversession-session-storage.js";
import { resolveClaudeSessionLogPath } from "../integrations/claude/log-paths.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { resolveSessionPathForCli } from "./session-ref.js";

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

async function resolveLogSession(params: {
  agent: AgentChoice;
  idArg?: string | undefined;
  cwd: string;
  codexSessionsDir: string;
}): Promise<
  { agent: "claude" | "codex"; sessionPath: string; sessionId?: string }
  | { error: string; exitCode: number }
> {
  const idRaw = params.idArg?.trim();

  if (idRaw && looksLikeJsonlPath(idRaw)) {
    const resolvedPath = await resolveSessionPathForCli({
      commandLabel: "log",
      idArg: idRaw,
      cwd: params.cwd,
      allowDiscover: false,
    });
    if (!resolvedPath.ok) return { error: resolvedPath.error, exitCode: resolvedPath.exitCode };

    const detected = await detectSession(resolvedPath.value.sessionPath);
    if (detected.agent !== "claude" && detected.agent !== "codex") {
      return { error: "[evs log] Unsupported or unknown session format (expected Claude or Codex JSONL).", exitCode: 2 };
    }

    if (params.agent === "claude" && detected.agent !== "claude") {
      return { error: "[evs log] Expected a Claude session file. Re-run with --agent codex or omit --agent.", exitCode: 2 };
    }
    if (params.agent === "codex" && detected.agent !== "codex") {
      return { error: "[evs log] Expected a Codex session file. Re-run with --agent claude or omit --agent.", exitCode: 2 };
    }

    const sessionId =
      detected.agent === "codex" ? await resolveCodexSessionIdFromTranscriptPath(resolvedPath.value.sessionPath) : undefined;
    return { agent: detected.agent, sessionPath: resolvedPath.value.sessionPath, ...(sessionId ? { sessionId } : {}) };
  }

  if (params.agent === "claude") {
    const resolved = await resolveSessionPathForCli({ commandLabel: "log", idArg: params.idArg, cwd: params.cwd, allowDiscover: true });
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
    if (report.agent === "unknown") return { error: "[evs log] No Codex session found for this cwd.", exitCode: 2 };
    if (report.confidence !== "high") {
      return {
        error: "[evs log] Cannot determine current Codex session with high confidence (ambiguous). Pass a session id.",
        exitCode: 2,
      };
    }
    const sessionId = report.session.id;
    return { agent: "codex", sessionPath: report.session.path, ...(sessionId ? { sessionId } : {}) };
  }

  // auto
  if (idRaw && idRaw.length > 0) {
    const claudeResolved = await resolveSessionPathForCli({
      commandLabel: "log",
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
      return { error: "[evs log] Session id matches both Claude and Codex. Re-run with --agent claude|codex.", exitCode: 2 };
    }
    if (claudePath) return { agent: "claude", sessionPath: claudePath };
    if (codexPath) return { agent: "codex", sessionPath: codexPath, sessionId: idRaw };
  }

  // No id: prefer Claude only when there is explicit hook/env context.
  const claudeContext = await resolveSessionPathForCli({ commandLabel: "log", cwd: params.cwd, allowDiscover: false });
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

  const claudeDiscover = await resolveSessionPathForCli({ commandLabel: "log", cwd: params.cwd, allowDiscover: true });
  if (claudeDiscover.ok) return { agent: "claude", sessionPath: claudeDiscover.value.sessionPath };

  return { error: "[evs log] No session found. Pass a .jsonl path or session id.", exitCode: 2 };
}

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .alias("compact-log")
    .description("Show auto-compact history for the current Claude Code or Codex session")
    .argument("[id]", "session UUID or .jsonl path")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--tail <n>", "show last N auto-compact entries (default: 20)")
    .option("--all", "show all auto-compact entries")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .action(async (idArg: string | undefined, opts: { agent?: string; tail?: string; all?: boolean; cwd?: string; codexSessionsDir?: string }) => {
      const cwd = opts.cwd ?? process.cwd();
      const agentRaw = (opts.agent ?? "auto").trim();
      if (!isAgentChoice(agentRaw)) {
        process.stderr.write("[evs log] Invalid --agent value (expected auto|claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const resolved = await resolveLogSession({
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

      let logPath: string;
      if (resolved.agent === "claude") {
        const resolvedLog = await resolveClaudeSessionLogPath(resolved.sessionPath);
        if (!resolvedLog) {
          process.stderr.write(
            `[evs log] No log file found (checked: ${resolved.sessionPath}.evs.log and EverSession central log)\n`,
          );
          process.exitCode = 2;
          return;
        }
        logPath = resolvedLog.path;
      } else {
        const sessionId = resolved.sessionId ?? (await resolveCodexSessionIdFromTranscriptPath(resolved.sessionPath));
        if (!sessionId) {
          process.stderr.write("[evs log] Cannot determine Codex session id. Pass a session id.\n");
          process.exitCode = 2;
          return;
        }
        logPath = getLogPath(sessionId);
        if (!(await fileExists(logPath))) {
          process.stderr.write("[evs log] No log file found (checked: EverSession central log)\n");
          process.exitCode = 2;
          return;
        }
      }

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
