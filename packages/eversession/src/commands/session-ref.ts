import * as path from "node:path";

import { detectSession } from "../agents/detect.js";
import { fileExists } from "../core/fs.js";
import { expandHome } from "../core/paths.js";
import { defaultClaudeProjectsDir } from "../integrations/claude/paths.js";
import { isUuid } from "../integrations/claude/context.js";
import { resolveClaudeTranscriptByUuidInProject } from "../integrations/claude/session-discovery.js";
import { readClaudeSupervisorEnv, readSupervisorHandshake as readClaudeSupervisorHandshake } from "../integrations/claude/supervisor-control.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { readCodexSupervisorEnv, readSupervisorHandshake as readCodexSupervisorHandshake } from "../integrations/codex/supervisor-control.js";

export type ResolvedSession = {
  agent: "claude" | "codex";
  sessionPath: string;
  source: "arg:path" | "arg:id" | "supervisor";
};

export type ResolveSessionResult = { ok: true; value: ResolvedSession } | { ok: false; error: string; exitCode: number };

export function isPathLike(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.endsWith(".jsonl") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".")
  );
}

export function looksLikeSessionRef(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return isUuid(trimmed) || isPathLike(trimmed);
}

function normalizeAgentHint(value: string | undefined): "auto" | "claude" | "codex" | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "auto" || trimmed === "claude" || trimmed === "codex") return trimmed;
  return undefined;
}

export async function resolveSessionForCli(params: {
  commandLabel: string;
  refArg?: string | undefined;
  agent?: string | undefined;
  cwd?: string;
}): Promise<ResolveSessionResult> {
  const refRaw = params.refArg?.trim();
  const cwd = params.cwd ?? process.cwd();
  const agentHint = normalizeAgentHint(params.agent) ?? "auto";

  if (refRaw && refRaw.length > 0) {
    if (isPathLike(refRaw)) {
      const resolvedPath = path.resolve(expandHome(refRaw));
      if (!(await fileExists(resolvedPath))) {
        return { ok: false, exitCode: 2, error: `[evs ${params.commandLabel}] Session file not found: ${resolvedPath}` };
      }
      const detected = await detectSession(resolvedPath);
      if (detected.agent !== "claude" && detected.agent !== "codex") {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] Unsupported or unknown session format (expected Claude or Codex JSONL).`,
        };
      }
      return { ok: true, value: { agent: detected.agent, sessionPath: resolvedPath, source: "arg:path" } };
    }

    if (isUuid(refRaw)) {
      const wantsClaude = agentHint === "auto" || agentHint === "claude";
      const wantsCodex = agentHint === "auto" || agentHint === "codex";

      const claudePath = wantsClaude
        ? await resolveClaudeTranscriptByUuidInProject({
            uuid: refRaw,
            cwd,
            claudeProjectsDir: defaultClaudeProjectsDir(),
          })
        : undefined;

      const codexReport = wantsCodex
        ? await discoverCodexSessionReport({
            cwd,
            codexSessionsDir: defaultCodexSessionsDir(),
            sessionId: refRaw,
            fallback: true,
            lookbackDays: 14,
            maxCandidates: 200,
            tailLines: 500,
            validate: false,
          })
        : undefined;
      const codexPath = codexReport?.agent === "codex" ? codexReport.session.path : undefined;

      if (claudePath && codexPath && agentHint === "auto") {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] Session id matches both Claude and Codex. Re-run with --agent claude|codex.`,
        };
      }
      if (claudePath) return { ok: true, value: { agent: "claude", sessionPath: claudePath, source: "arg:id" } };
      if (codexPath) return { ok: true, value: { agent: "codex", sessionPath: codexPath, source: "arg:id" } };

      if (agentHint === "claude") {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] No Claude session found for id=${refRaw} in this project.`,
        };
      }
      if (agentHint === "codex") {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] No Codex session found for id=${refRaw} in lookback window.`,
        };
      }
      return { ok: false, exitCode: 2, error: `[evs ${params.commandLabel}] No session found for id=${refRaw}.` };
    }

    return {
      ok: false,
      exitCode: 2,
      error: `[evs ${params.commandLabel}] Expected a session path (*.jsonl) or UUID.`,
    };
  }

  // No ref: only allowed under an active EVS supervisor.
  const claudeSupervisor = readClaudeSupervisorEnv();
  if (claudeSupervisor) {
    const hs = await readClaudeSupervisorHandshake(claudeSupervisor.controlDir);
    if (!hs || hs.runId !== claudeSupervisor.runId) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Cannot resolve current session (missing supervisor handshake).`,
      };
    }
    const resolvedPath = path.resolve(expandHome(hs.transcriptPath));
    if (!(await fileExists(resolvedPath))) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Supervisor transcript path points to a missing file: ${resolvedPath}`,
      };
    }
    return { ok: true, value: { agent: "claude", sessionPath: resolvedPath, source: "supervisor" } };
  }

  const codexSupervisor = readCodexSupervisorEnv();
  if (codexSupervisor) {
    const hs = await readCodexSupervisorHandshake(codexSupervisor.controlDir);
    if (!hs || hs.runId !== codexSupervisor.runId || hs.threadId.trim().length === 0) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Cannot resolve current session (missing supervisor handshake).`,
      };
    }
    const report = await discoverCodexSessionReport({
      cwd: hs.cwd,
      codexSessionsDir: defaultCodexSessionsDir(),
      sessionId: hs.threadId,
      fallback: false,
      lookbackDays: 14,
      maxCandidates: 200,
      tailLines: 500,
      validate: false,
    });
    if (report.agent !== "codex" || report.confidence !== "high") {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Cannot resolve current Codex session (ambiguous or not found). Pass an explicit session id/path.`,
      };
    }
    return { ok: true, value: { agent: "codex", sessionPath: report.session.path, source: "supervisor" } };
  }

  return {
    ok: false,
    exitCode: 2,
    error: `[evs ${params.commandLabel}] Missing session. Run under \`evs claude\` / \`evs codex\`, or pass a session id/path.`,
  };
}

