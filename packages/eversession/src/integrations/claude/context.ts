import { asString, isJsonObject } from "../../core/json.js";
import { expandHome } from "../../core/paths.js";
import type { ClaudeHookInput } from "./hook-input.js";

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export function extractUuidFromJsonlPath(value: string): string | undefined {
  const m = value.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m?.[1];
}

function collectStrings(value: unknown, out: string[], depth: number, maxDepth: number, maxItems: number): void {
  if (out.length >= maxItems) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (depth >= maxDepth) return;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1, maxDepth, maxItems);
    return;
  }
  if (isJsonObject(value)) {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1, maxDepth, maxItems);
  }
}

export function extractClaudeSessionIdFromPayload(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return undefined;

  const candidates: Array<string | undefined> = [
    asString(payload.session_id),
    asString(payload.sessionId),
    asString(payload.conversation_id),
    asString(payload.conversationId),
    isJsonObject(payload.session) ? asString(payload.session.id) : undefined,
    isJsonObject(payload.session) ? asString(payload.session.sessionId) : undefined,
    isJsonObject(payload.session) ? asString(payload.session.session_id) : undefined,
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (isUuid(c)) return c;
    const fromPath = extractUuidFromJsonlPath(c);
    if (fromPath && isUuid(fromPath)) return fromPath;
  }

  // Fallback: scan payload strings for a direct `.../<uuid>.jsonl` reference.
  const strings: string[] = [];
  collectStrings(payload, strings, 0, 6, 500);
  for (const s of strings) {
    const fromPath = extractUuidFromJsonlPath(s);
    if (fromPath && isUuid(fromPath)) return fromPath;
  }

  return undefined;
}

export function extractClaudeCwdFromPayload(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return undefined;
  const direct = asString(payload.cwd);
  if (direct) return direct;
  if (isJsonObject(payload.payload)) {
    const nested = asString(payload.payload.cwd);
    if (nested) return nested;
  }
  return undefined;
}

export function resolveClaudeActiveCwd(cwdOverride?: string): string {
  const override = cwdOverride?.trim();
  if (override) return override;
  const candidates = [
    process.env.CLAUDE_PROJECT_DIR,
    process.env.EVS_CLAUDE_PROJECT_DIR,
    process.env.EVS_CLAUDE_HOOK_CWD,
    process.cwd(),
  ];
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed) return trimmed;
  }
  return process.cwd();
}

export function resolveClaudeProjectDirFromEnv(): string | undefined {
  const primary = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (primary && primary.length > 0) return primary;
  const fallback = process.env.EVS_CLAUDE_PROJECT_DIR?.trim();
  if (fallback && fallback.length > 0) return fallback;
  return undefined;
}

export function resolveClaudeEnvFilePathFromEnv(): string | undefined {
  const raw = process.env.CLAUDE_ENV_FILE?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export function resolveClaudeTranscriptPathFromEnv(): string | undefined {
  const raw = process.env.EVS_CLAUDE_TRANSCRIPT_PATH?.trim();
  if (!raw) return undefined;
  return expandHome(raw);
}

export function resolveClaudeKnownSessionId(explicit?: string): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;

  const envId = process.env.EVS_CLAUDE_SESSION_ID?.trim();
  if (envId && envId.length > 0) return envId;

  const envUuid = process.env.EVS_CLAUDE_TRANSCRIPT_UUID?.trim();
  if (envUuid && envUuid.length > 0) return envUuid;

  return undefined;
}

export function isClaudeHookInvocation(hook: ClaudeHookInput | undefined): boolean {
  return hook !== undefined || resolveClaudeProjectDirFromEnv() !== undefined;
}

export function getClaudeStatuslineEnvDump(): { CLAUDE_PROJECT_DIR?: string; CLAUDE_ENV_FILE?: string; PWD?: string } {
  const out: { CLAUDE_PROJECT_DIR?: string; CLAUDE_ENV_FILE?: string; PWD?: string } = {};
  if (process.env.CLAUDE_PROJECT_DIR) out.CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
  if (process.env.CLAUDE_ENV_FILE) out.CLAUDE_ENV_FILE = process.env.CLAUDE_ENV_FILE;
  if (process.env.PWD) out.PWD = process.env.PWD;
  return out;
}
