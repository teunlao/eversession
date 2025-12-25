import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverClaudeSession } from "../../agents/claude/discover.js";
import type {
  SessionConfidence,
  SessionDiscoveryMethod,
  SessionDiscoveryReport,
} from "../../agents/session-discovery/types.js";
import { fileExists } from "../../core/fs.js";
import { deriveSessionIdFromPath } from "../../core/paths.js";
import {
  extractClaudeCwdFromPayload,
  extractClaudeSessionIdFromPayload,
  extractUuidFromJsonlPath,
  resolveClaudeActiveCwd,
  resolveClaudeTranscriptPathFromEnv,
} from "./context.js";
import type { ClaudeHookInput } from "./hook-input.js";
import { claudeProjectHashFromTranscriptPath, defaultClaudeProjectsDir } from "./paths.js";

export type ClaudeActiveSession = {
  sessionPath: string;
  sessionId: string;
  method: SessionDiscoveryMethod;
  confidence: SessionConfidence;
  cwd: string;
  mtime?: string;
  lastActivity?: string;
  projectHash?: string;
};

export async function resolveClaudeActiveSession(opts: {
  cwd?: string;
  claudeProjectsDir?: string;
  hook?: ClaudeHookInput;
  allowDiscover?: boolean;
  validate?: boolean;
}): Promise<ClaudeActiveSession | { error: "not_found"; issues?: unknown[] }> {
  const hook = opts.hook;
  const hookPayload = hook?.raw;
  const cwd = resolveClaudeActiveCwd(opts.cwd ?? hook?.cwd ?? extractClaudeCwdFromPayload(hookPayload));
  const claudeProjectsDir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();

  const hookTranscript = hook?.transcriptPath ? path.resolve(hook.transcriptPath) : undefined;
  const envTranscriptRaw = resolveClaudeTranscriptPathFromEnv();
  const envTranscript = envTranscriptRaw ? path.resolve(envTranscriptRaw) : undefined;

  const transcriptPath =
    hookTranscript && (await fileExists(hookTranscript))
      ? hookTranscript
      : envTranscript && (await fileExists(envTranscript))
        ? envTranscript
        : undefined;

  if (transcriptPath) {
    let mtime: string | undefined;
    try {
      const st = await fs.stat(transcriptPath);
      mtime = st.mtime.toISOString();
    } catch {
      mtime = undefined;
    }

    const method: SessionDiscoveryMethod = hookTranscript === transcriptPath ? "hook" : "env";
    const projectHash = claudeProjectHashFromTranscriptPath(transcriptPath);
    const sessionId =
      hook?.sessionId ?? extractUuidFromJsonlPath(transcriptPath) ?? deriveSessionIdFromPath(transcriptPath);

    return {
      sessionPath: transcriptPath,
      sessionId,
      method,
      confidence: "high",
      cwd,
      ...(projectHash ? { projectHash } : {}),
      ...(mtime ? { mtime } : {}),
    };
  }

  if (opts.allowDiscover === false) {
    return { error: "not_found" };
  }

  const hookSessionId = extractClaudeSessionIdFromPayload(hookPayload);
  let discovered = await discoverClaudeSession({
    cwd,
    claudeProjectsDir,
    fallback: false,
    maxCandidates: 200,
    tailLines: 500,
    includeSidechains: false,
    validate: opts.validate ?? true,
    ...(hookSessionId ? { sessionId: hookSessionId } : {}),
  });

  if (discovered.agent === "unknown" && hookSessionId) {
    discovered = await discoverClaudeSession({
      cwd,
      claudeProjectsDir,
      fallback: false,
      maxCandidates: 200,
      tailLines: 500,
      includeSidechains: false,
      validate: opts.validate ?? true,
    });
  }

  if (discovered.agent === "unknown") {
    return { error: "not_found", issues: discovered.issues };
  }

  if (!discovered.session.id) {
    return { error: "not_found" };
  }

  return {
    sessionPath: discovered.session.path,
    sessionId: discovered.session.id,
    method: discovered.method,
    confidence: discovered.confidence,
    cwd,
    ...(discovered.session.mtime ? { mtime: discovered.session.mtime } : {}),
    ...(discovered.session.lastActivity ? { lastActivity: discovered.session.lastActivity } : {}),
    ...(discovered.session.projectHash ? { projectHash: discovered.session.projectHash } : {}),
  };
}

export async function resolveClaudeSessionPathFromInputs(params: {
  cwd: string;
  hookPath?: string;
  explicitPath?: string;
  allowDiscover?: boolean;
}): Promise<string | undefined> {
  if (params.explicitPath) return params.explicitPath;
  if (params.hookPath) return params.hookPath;

  const resolved = await resolveClaudeActiveSession({
    cwd: params.cwd,
    allowDiscover: params.allowDiscover ?? true,
    validate: false,
  });
  if ("error" in resolved) return undefined;
  return resolved.sessionPath;
}

export function toClaudeSessionDiscoveryReport(session: ClaudeActiveSession): SessionDiscoveryReport {
  return {
    agent: "claude",
    cwd: session.cwd,
    method: session.method,
    confidence: session.confidence,
    session: {
      path: session.sessionPath,
      agent: "claude",
      method: session.method,
      confidence: session.confidence,
      ...(session.sessionId ? { id: session.sessionId } : {}),
      cwd: session.cwd,
      ...(session.projectHash ? { projectHash: session.projectHash } : {}),
      ...(session.mtime ? { mtime: session.mtime } : {}),
      ...(session.lastActivity ? { lastActivity: session.lastActivity } : {}),
    },
    alternatives: [],
  };
}
