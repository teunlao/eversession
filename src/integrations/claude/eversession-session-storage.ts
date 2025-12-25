/**
 * EverSession Session Storage - centralized session data storage.
 *
 * Structure:
 * ~/.claude/.eversession/
 * └── sessions/
 *     └── {session-uuid}/
 *         ├── backups/           # backups before compact/fix
 *         ├── log.jsonl          # events (append-only)
 *         └── state.json         # current state
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";
import { claudeEversessionBaseDir } from "./paths.js";

// ============================================
// Types
// ============================================

export interface PendingReload {
  ts: string;
  reason: string;
}

export interface LastCompact {
  ts: string;
  tokensBefore: number;
  tokensAfter: number;
  model: string;
}

export interface ProjectInfo {
  cwd: string;
  hash: string;
}

export interface SessionState {
  pendingReload?: PendingReload | null;
  lastCompact?: LastCompact | null;
  project?: ProjectInfo | null;
}

export interface LogEntry {
  ts?: string;
  event: string;
  [key: string]: unknown;
}

// ============================================
// Paths
// ============================================

export function getEversessionBaseDir(): string {
  return claudeEversessionBaseDir();
}

export function getSessionsDir(): string {
  return path.join(getEversessionBaseDir(), "sessions");
}

export function getSessionDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId);
}

export function getStatePath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "state.json");
}

export function getLogPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "log.jsonl");
}

export function getBackupsDir(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "backups");
}

// ============================================
// State CRUD
// ============================================

function parseState(value: unknown): SessionState | undefined {
  if (!isJsonObject(value)) return undefined;

  const state: SessionState = {};

  if (isJsonObject(value.pendingReload)) {
    const ts = asString(value.pendingReload.ts);
    const reason = asString(value.pendingReload.reason);
    if (ts && reason) {
      state.pendingReload = { ts, reason };
    }
  } else if (value.pendingReload === null) {
    state.pendingReload = null;
  }

  if (isJsonObject(value.lastCompact)) {
    const ts = asString(value.lastCompact.ts);
    const tokensBefore =
      typeof value.lastCompact.tokensBefore === "number" ? value.lastCompact.tokensBefore : undefined;
    const tokensAfter = typeof value.lastCompact.tokensAfter === "number" ? value.lastCompact.tokensAfter : undefined;
    const model = asString(value.lastCompact.model);
    if (ts && tokensBefore !== undefined && tokensAfter !== undefined && model) {
      state.lastCompact = { ts, tokensBefore, tokensAfter, model };
    }
  } else if (value.lastCompact === null) {
    state.lastCompact = null;
  }

  if (isJsonObject(value.project)) {
    const cwd = asString(value.project.cwd);
    const hash = asString(value.project.hash);
    if (cwd && hash) {
      state.project = { cwd, hash };
    }
  } else if (value.project === null) {
    state.project = null;
  }

  return state;
}

export async function readSessionState(sessionId: string): Promise<SessionState | undefined> {
  const statePath = getStatePath(sessionId);
  if (!(await fileExists(statePath))) return undefined;

  try {
    const text = await fs.readFile(statePath, "utf8");
    const obj: unknown = JSON.parse(text);
    return parseState(obj);
  } catch {
    return undefined;
  }
}

export async function writeSessionState(sessionId: string, state: SessionState): Promise<void> {
  const sessionDir = getSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const statePath = getStatePath(sessionId);
  await writeFileAtomic(statePath, JSON.stringify(state, null, 2));
}

export async function updateSessionState(sessionId: string, partial: Partial<SessionState>): Promise<void> {
  const existing = await readSessionState(sessionId);
  const merged: SessionState = { ...(existing ?? {}), ...partial };
  await writeSessionState(sessionId, merged);
}

export async function clearPendingReload(sessionId: string): Promise<void> {
  await updateSessionState(sessionId, { pendingReload: null });
}

// ============================================
// Log
// ============================================

export async function appendSessionLog(sessionId: string, entry: LogEntry): Promise<void> {
  const sessionDir = getSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const logPath = getLogPath(sessionId);
  const line: LogEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  await fs.appendFile(logPath, JSON.stringify(line) + "\n", "utf8");
}

// ============================================
// Backups
// ============================================

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${ms}`;
}

export async function createSessionBackup(sessionId: string, sourcePath: string): Promise<string> {
  const backupsDir = getBackupsDir(sessionId);
  await fs.mkdir(backupsDir, { recursive: true });

  const timestamp = formatTimestamp(new Date());
  const backupPath = path.join(backupsDir, `${timestamp}.jsonl`);

  await fs.copyFile(sourcePath, backupPath);

  return backupPath;
}

export async function cleanupOldBackups(sessionId: string, keep: number): Promise<number> {
  const backupsDir = getBackupsDir(sessionId);
  if (!(await fileExists(backupsDir))) return 0;

  let entries: string[];
  try {
    entries = await fs.readdir(backupsDir);
  } catch {
    return 0;
  }

  // Filter only .jsonl files and sort by name (timestamp) descending
  const backups = entries
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (backups.length <= keep) return 0;

  const toDelete = backups.slice(keep);
  let deleted = 0;

  for (const name of toDelete) {
    try {
      await fs.unlink(path.join(backupsDir, name));
      deleted++;
    } catch {
      // ignore individual failures
    }
  }

  return deleted;
}

async function tryStatMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}

export async function getSessionLastActivityMs(sessionId: string): Promise<number | undefined> {
  const sessionDir = getSessionDir(sessionId);
  const candidates = await Promise.all([
    tryStatMtimeMs(sessionDir),
    tryStatMtimeMs(getStatePath(sessionId)),
    tryStatMtimeMs(getLogPath(sessionId)),
    tryStatMtimeMs(getBackupsDir(sessionId)),
  ]);

  const numbers = candidates.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (numbers.length === 0) return undefined;
  const last = Math.max(...numbers);
  return last > 0 ? last : undefined;
}

export async function listSessions(): Promise<string[]> {
  const sessionsDir = getSessionsDir();
  if (!(await fileExists(sessionsDir))) return [];
  try {
    const entries = await fs.readdir(sessionsDir);
    const sessions: string[] = [];
    for (const name of entries) {
      const sessionDir = path.join(sessionsDir, name);
      try {
        const stat = await fs.stat(sessionDir);
        if (stat.isDirectory()) sessions.push(name);
      } catch {
        // ignore
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function cleanupOldSessions(maxAgeDays: number): Promise<{ deleted: number; errors: number }> {
  const sessionsDir = getSessionsDir();
  if (!(await fileExists(sessionsDir))) return { deleted: 0, errors: 0 };

  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return { deleted: 0, errors: 0 };
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let errors = 0;

  for (const name of entries) {
    const sessionDir = path.join(sessionsDir, name);
    try {
      const stat = await fs.stat(sessionDir);
      if (!stat.isDirectory()) continue;
      // Use "last activity" based on session files (directory mtime is not updated on log appends).
      const lastActivityMs = await getSessionLastActivityMs(name);
      const age = now - (lastActivityMs ?? stat.mtimeMs);
      if (age < maxAgeMs) continue;
      // Remove the entire session directory
      await fs.rm(sessionDir, { recursive: true, force: true });
      deleted++;
    } catch {
      errors++;
    }
  }

  return { deleted, errors };
}
