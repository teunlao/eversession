import * as fs from "node:fs/promises";
import * as path from "node:path";

import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asBoolean, asNumber, asString, isJsonObject } from "../../core/json.js";
import { getSessionDir } from "../claude/eversession-session-storage.js";

export type CodexPendingCompactStatus = "running" | "ready" | "failed" | "stale";

export type CodexPendingCompactSelection = {
  removeCount: number;
  firstRemovedLine?: number;
  lastRemovedLine?: number;
  anchorLine?: number;
};

export type CodexPendingCompactSource = {
  mtimeMs?: number;
  size?: number;
};

export type CodexPendingCompact = {
  schemaVersion: 1;
  sessionId: string;
  status: CodexPendingCompactStatus;
  createdAt: string;
  readyAt?: string;
  failedAt?: string;
  thresholdTokens?: number;
  tokensAtTrigger?: number;
  backup?: boolean;
  amountMode?: "messages" | "tokens";
  amountRaw?: string;
  model?: string;
  summary?: string;
  selection?: CodexPendingCompactSelection;
  source?: CodexPendingCompactSource;
  error?: string;
};

export function codexPendingCompactPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "pending-compact.codex.json");
}

function parseSelection(value: unknown): CodexPendingCompactSelection | undefined {
  if (!isJsonObject(value)) return undefined;
  const removeCount = asNumber(value.removeCount);
  if (removeCount === undefined || !Number.isFinite(removeCount) || removeCount < 0) return undefined;

  const firstRemovedLine = asNumber(value.firstRemovedLine);
  const lastRemovedLine = asNumber(value.lastRemovedLine);
  const anchorLine = asNumber(value.anchorLine);

  const out: CodexPendingCompactSelection = { removeCount };

  if (firstRemovedLine !== undefined && Number.isFinite(firstRemovedLine) && firstRemovedLine > 0) out.firstRemovedLine = firstRemovedLine;
  if (lastRemovedLine !== undefined && Number.isFinite(lastRemovedLine) && lastRemovedLine > 0) out.lastRemovedLine = lastRemovedLine;
  if (anchorLine !== undefined && Number.isFinite(anchorLine) && anchorLine > 0) out.anchorLine = anchorLine;

  return out;
}

function parseSource(value: unknown): CodexPendingCompactSource | undefined {
  if (!isJsonObject(value)) return undefined;
  const mtimeMs = asNumber(value.mtimeMs);
  const size = asNumber(value.size);
  return {
    ...(mtimeMs !== undefined && Number.isFinite(mtimeMs) && mtimeMs >= 0 ? { mtimeMs } : {}),
    ...(size !== undefined && Number.isFinite(size) && size >= 0 ? { size } : {}),
  };
}

export function parseCodexPendingCompact(value: unknown): CodexPendingCompact | undefined {
  if (!isJsonObject(value)) return undefined;
  const schemaVersion = asNumber(value.schemaVersion);
  if (schemaVersion !== 1) return undefined;

  const sessionId = asString(value.sessionId);
  if (!sessionId) return undefined;

  const statusRaw = asString(value.status);
  const status: CodexPendingCompactStatus | undefined =
    statusRaw === "running" || statusRaw === "ready" || statusRaw === "failed" || statusRaw === "stale"
      ? statusRaw
      : undefined;
  if (!status) return undefined;

  const createdAt = asString(value.createdAt);
  if (!createdAt) return undefined;

  const readyAt = asString(value.readyAt);
  const failedAt = asString(value.failedAt);
  const thresholdTokens = asNumber(value.thresholdTokens);
  const tokensAtTrigger = asNumber(value.tokensAtTrigger);
  const backup = asBoolean(value.backup);
  const amountModeRaw = asString(value.amountMode);
  const amountMode: "messages" | "tokens" | undefined =
    amountModeRaw === "messages" || amountModeRaw === "tokens" ? amountModeRaw : undefined;
  const amountRaw = asString(value.amountRaw);
  const model = asString(value.model);
  const summary = asString(value.summary);
  const selection = parseSelection(value.selection);
  const source = parseSource(value.source);
  const error = asString(value.error);

  return {
    schemaVersion: 1,
    sessionId,
    status,
    createdAt,
    ...(readyAt ? { readyAt } : {}),
    ...(failedAt ? { failedAt } : {}),
    ...(thresholdTokens !== undefined && Number.isFinite(thresholdTokens) ? { thresholdTokens } : {}),
    ...(tokensAtTrigger !== undefined && Number.isFinite(tokensAtTrigger) ? { tokensAtTrigger } : {}),
    ...(backup !== undefined ? { backup } : {}),
    ...(amountMode ? { amountMode } : {}),
    ...(amountRaw ? { amountRaw } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    ...(selection ? { selection } : {}),
    ...(source ? { source } : {}),
    ...(error ? { error } : {}),
  };
}

export async function readCodexPendingCompact(sessionId: string): Promise<CodexPendingCompact | undefined> {
  const filePath = codexPendingCompactPath(sessionId);
  if (!(await fileExists(filePath))) return undefined;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const obj: unknown = JSON.parse(text);
    return parseCodexPendingCompact(obj);
  } catch {
    return undefined;
  }
}

export async function writeCodexPendingCompact(sessionId: string, compact: CodexPendingCompact): Promise<void> {
  const filePath = codexPendingCompactPath(sessionId);
  await writeFileAtomic(filePath, JSON.stringify(compact, null, 2));
}

export async function clearCodexPendingCompact(sessionId: string): Promise<void> {
  const filePath = codexPendingCompactPath(sessionId);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}
