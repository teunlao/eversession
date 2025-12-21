import * as fs from "node:fs/promises";
import * as path from "node:path";

import { normalizeCwdCandidates } from "../../agents/session-discovery/shared.js";
import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";
import { BRAND } from "../../core/brand.js";
import { claudeEversessionBaseDir } from "../claude/paths.js";

export type CodexNotifyEvent = {
  type: "agent-turn-complete";
  "thread-id": string;
  "turn-id"?: string;
  cwd: string;
};

export type CodexCurrentSession = {
  threadId: string;
  turnId?: string;
  updatedAt: string;
};

type CodexStateV1 = {
  schemaVersion: 1;
  updatedAt: string;
  byCwd: Record<string, CodexCurrentSession>;
};

const DEFAULT_STATE_FILE_NAME = "codex-state.json";

function parseCodexCurrentSession(value: unknown): CodexCurrentSession | undefined {
  if (!isJsonObject(value)) return undefined;

  const threadId = asString(value.threadId);
  const turnId = asString(value.turnId);
  const updatedAt = asString(value.updatedAt);
  if (!threadId || !updatedAt) return undefined;

  const out: CodexCurrentSession = { threadId, updatedAt };
  if (turnId) out.turnId = turnId;
  return out;
}

function parseCodexState(value: unknown): CodexStateV1 | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;

  const byCwdRaw = value.byCwd;
  if (!isJsonObject(byCwdRaw)) return undefined;

  const byCwd: Record<string, CodexCurrentSession> = {};
  for (const [cwd, v] of Object.entries(byCwdRaw)) {
    if (typeof cwd !== "string" || cwd.trim().length === 0) continue;
    const parsed = parseCodexCurrentSession(v);
    if (!parsed) continue;
    byCwd[cwd] = parsed;
  }

  return {
    schemaVersion: 1,
    updatedAt: asString(value.updatedAt) ?? new Date().toISOString(),
    byCwd,
  };
}

export function resolveCodexStatePath(statePathArg?: string | undefined): string {
  const raw = statePathArg?.trim() || process.env[BRAND.env.codex.statePath]?.trim();
  const defaultPath = path.join(claudeEversessionBaseDir(), DEFAULT_STATE_FILE_NAME);
  const chosen = raw && raw.length > 0 ? raw : defaultPath;
  return path.resolve(chosen);
}

export async function loadCodexState(statePath: string): Promise<CodexStateV1> {
  if (!(await fileExists(statePath))) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), byCwd: {} };
  }

  const text = await fs.readFile(statePath, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in Codex state file: ${statePath}`);
  }

  const parsed = parseCodexState(obj);
  if (!parsed) throw new Error(`Unrecognized Codex state file format: ${statePath}`);
  return parsed;
}

export async function saveCodexState(statePath: string, state: CodexStateV1): Promise<void> {
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });

  const next: CodexStateV1 = { ...state, updatedAt: new Date().toISOString(), schemaVersion: 1 };
  await writeFileAtomic(statePath, JSON.stringify(next, null, 2));
}

export async function updateCodexStateFromNotify(params: { statePath: string; event: CodexNotifyEvent }): Promise<void> {
  const state = await loadCodexState(params.statePath);

  const now = new Date().toISOString();
  const entry: CodexCurrentSession = { threadId: params.event["thread-id"], updatedAt: now };
  const turnId = params.event["turn-id"]?.trim();
  if (turnId) entry.turnId = turnId;

  const byCwd: Record<string, CodexCurrentSession> = { ...state.byCwd, [params.event.cwd]: entry };
  await saveCodexState(params.statePath, { ...state, byCwd });
}

export async function resolveCodexThreadIdForCwd(params: {
  cwd: string;
  statePath: string;
}): Promise<string | undefined> {
  const state = await loadCodexState(params.statePath);
  const candidates = await normalizeCwdCandidates(params.cwd);
  for (const candidate of candidates) {
    const hit = state.byCwd[candidate];
    if (hit?.threadId) return hit.threadId;
  }
  return undefined;
}

export function parseCodexNotifyEvent(value: unknown): CodexNotifyEvent | undefined {
  if (!isJsonObject(value)) return undefined;

  const type = asString(value.type);
  if (type !== "agent-turn-complete") return undefined;

  const threadId = asString(value["thread-id"]);
  const cwd = asString(value.cwd);
  const turnId = asString(value["turn-id"]);
  if (!threadId || !cwd) return undefined;

  const out: CodexNotifyEvent = { type: "agent-turn-complete", "thread-id": threadId, cwd };
  if (turnId) out["turn-id"] = turnId;
  return out;
}
