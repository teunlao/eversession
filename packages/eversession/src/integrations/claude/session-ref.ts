import * as path from "node:path";

import { fileExists } from "../../core/fs.js";
import { expandHome } from "../../core/paths.js";
import { isUuid, resolveClaudeActiveCwd, resolveClaudeTranscriptPathFromEnv } from "./context.js";
import { readClaudeHookInputIfAny } from "./hook-input.js";
import { defaultClaudeProjectsDir } from "./paths.js";
import { discoverClaudeSessionReport, resolveClaudeTranscriptByUuidInProject } from "./session-discovery.js";

export type ResolvedSessionPath = {
  sessionPath: string;
  source: "arg:path" | "arg:uuid" | "hook" | "env" | "discover";
};

export type ResolveSessionPathResult =
  | { ok: true; value: ResolvedSessionPath }
  | { ok: false; error: string; exitCode: number };

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

export async function resolveClaudeSessionRefForCli(params: {
  commandLabel: string;
  idArg?: string | undefined;
  allowDiscover?: boolean;
  cwd?: string;
}): Promise<ResolveSessionPathResult> {
  const idRaw = params.idArg?.trim();

  if (idRaw && idRaw.length > 0) {
    if (isUuid(idRaw)) {
      const cwd = resolveClaudeActiveCwd(params.cwd);
      const found = await resolveClaudeTranscriptByUuidInProject({
        uuid: idRaw,
        cwd,
        claudeProjectsDir: defaultClaudeProjectsDir(),
      });
      if (!found) {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] No Claude session found for uuid=${idRaw} in this project. Pass a .jsonl path instead.`,
        };
      }
      return { ok: true, value: { sessionPath: found, source: "arg:uuid" } };
    }

    if (isPathLike(idRaw)) {
      const resolved = path.resolve(expandHome(idRaw));
      if (!(await fileExists(resolved))) {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] Session file not found: ${resolved}`,
        };
      }
      return { ok: true, value: { sessionPath: resolved, source: "arg:path" } };
    }

    return {
      ok: false,
      exitCode: 2,
      error: `[evs ${params.commandLabel}] Expected a session path (*.jsonl) or UUID.`,
    };
  }

  // 1) Claude hook context (stdin JSON)
  const hook = await readClaudeHookInputIfAny(25);
  if (hook?.transcriptPath) {
    const resolved = path.resolve(expandHome(hook.transcriptPath));
    if (!(await fileExists(resolved))) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Hook transcript path points to a missing file: ${resolved}`,
      };
    }
    return { ok: true, value: { sessionPath: resolved, source: "hook" } };
  }

  // 2) Bash mode env (written via `evs hook-env`)
  const envPath = resolveClaudeTranscriptPathFromEnv();
  if (envPath) {
    const resolved = path.resolve(expandHome(envPath));
    if (!(await fileExists(resolved))) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] EVS_CLAUDE_TRANSCRIPT_PATH points to a missing file: ${resolved}`,
      };
    }
    return { ok: true, value: { sessionPath: resolved, source: "env" } };
  }

  if (params.allowDiscover !== false) {
    const cwd = resolveClaudeActiveCwd(params.cwd);
    const report = await discoverClaudeSessionReport({
      cwd,
      claudeProjectsDir: defaultClaudeProjectsDir(),
      fallback: false,
      maxCandidates: 200,
      tailLines: 500,
      includeSidechains: false,
      validate: false,
    });

    if (report.agent === "claude") {
      if (report.confidence !== "high") {
        return {
          ok: false,
          exitCode: 2,
          error: `[evs ${params.commandLabel}] Cannot determine current Claude session with high confidence (ambiguous). Pass a .jsonl path or UUID.`,
        };
      }
      return { ok: true, value: { sessionPath: report.session.path, source: "discover" } };
    }
  }

  return {
    ok: false,
    exitCode: 2,
    error: `[evs ${params.commandLabel}] Missing session. Pass a .jsonl path or UUID, or run inside Claude Code (hooks / ! bash mode).`,
  };
}
