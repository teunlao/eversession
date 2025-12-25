import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asBoolean, asNumber, asString, isJsonObject } from "../../core/json.js";
import { getSessionDir } from "./eversession-session-storage.js";

export type PendingCompactStatus = "running" | "ready" | "failed" | "stale";

export type PendingCompactSelection = {
  removeCount: number;
  firstRemovedUuid?: string;
  lastRemovedUuid?: string;
  anchorUuid?: string;
};

export type PendingCompactSource = {
  mtimeMs?: number;
  size?: number;
};

export type PendingCompact = {
  schemaVersion: 1;
  sessionId: string;
  status: PendingCompactStatus;
  createdAt: string;
  readyAt?: string;
  failedAt?: string;
  thresholdTokens?: number;
  tokensAtTrigger?: number;
  backup?: boolean;
  amountMode?: "messages" | "tokens";
  amountRaw?: string;
  keepLastRaw?: string;
  model?: string;
  summary?: string;
  selection?: PendingCompactSelection;
  source?: PendingCompactSource;
  error?: string;
};

export function pendingCompactPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "pending-compact.json");
}

function parsePendingCompactSelection(value: unknown): PendingCompactSelection | undefined {
  if (!isJsonObject(value)) return undefined;
  const removeCount = asNumber(value.removeCount);
  if (removeCount === undefined || !Number.isFinite(removeCount) || removeCount < 0) return undefined;
  const firstRemovedUuid = asString(value.firstRemovedUuid);
  const lastRemovedUuid = asString(value.lastRemovedUuid);
  const anchorUuid = asString(value.anchorUuid);
  return {
    removeCount,
    ...(firstRemovedUuid ? { firstRemovedUuid } : {}),
    ...(lastRemovedUuid ? { lastRemovedUuid } : {}),
    ...(anchorUuid ? { anchorUuid } : {}),
  };
}

function parsePendingCompactSource(value: unknown): PendingCompactSource | undefined {
  if (!isJsonObject(value)) return undefined;
  const mtimeMs = asNumber(value.mtimeMs);
  const size = asNumber(value.size);
  return {
    ...(mtimeMs !== undefined && Number.isFinite(mtimeMs) && mtimeMs >= 0 ? { mtimeMs } : {}),
    ...(size !== undefined && Number.isFinite(size) && size >= 0 ? { size } : {}),
  };
}

export function parsePendingCompact(value: unknown): PendingCompact | undefined {
  if (!isJsonObject(value)) return undefined;
  const schemaVersion = asNumber(value.schemaVersion);
  if (schemaVersion !== 1) return undefined;
  const sessionId = asString(value.sessionId);
  if (!sessionId) return undefined;

  const statusRaw = asString(value.status);
  const status: PendingCompactStatus | undefined =
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
  const amountMode = amountModeRaw === "messages" || amountModeRaw === "tokens" ? amountModeRaw : undefined;
  const amountRaw = asString(value.amountRaw);
  const keepLastRaw = asString(value.keepLastRaw);
  const model = asString(value.model);
  const summary = asString(value.summary);
  const selection = parsePendingCompactSelection(value.selection);
  const source = parsePendingCompactSource(value.source);
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
    ...(keepLastRaw ? { keepLastRaw } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    ...(selection ? { selection } : {}),
    ...(source ? { source } : {}),
    ...(error ? { error } : {}),
  };
}

export async function readPendingCompact(sessionId: string): Promise<PendingCompact | undefined> {
  const filePath = pendingCompactPath(sessionId);
  if (!(await fileExists(filePath))) return undefined;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const obj: unknown = JSON.parse(text);
    return parsePendingCompact(obj);
  } catch {
    return undefined;
  }
}

export async function writePendingCompact(sessionId: string, compact: PendingCompact): Promise<void> {
  const filePath = pendingCompactPath(sessionId);
  await writeFileAtomic(filePath, JSON.stringify(compact, null, 2));
}

export async function clearPendingCompact(sessionId: string): Promise<void> {
  const filePath = pendingCompactPath(sessionId);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}
