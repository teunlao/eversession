import * as fs from "node:fs/promises";
import * as path from "node:path";

import { asString, isJsonObject } from "../../core/json.js";
import { fileExists, writeFileAtomic } from "../../core/fs.js";

export type ReloadMode = "manual" | "auto" | "off";

export type ClaudeSupervisorEnv = {
  controlDir: string;
  runId: string;
  reloadMode: ReloadMode;
};

export type ClaudeSupervisorHandshake = {
  runId: string;
  sessionId: string;
  transcriptPath: string;
  ts: string;
};

export type ClaudeSupervisorControlCommand = {
  ts: string;
  cmd: "reload";
  reason: string;
};

export type ClaudeSupervisorPendingReload = {
  ts: string;
  reason: string;
};

export function parseReloadMode(value: string | undefined): ReloadMode | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "manual" || trimmed === "auto" || trimmed === "off") return trimmed;
  return undefined;
}

export function readClaudeSupervisorEnv(env: NodeJS.ProcessEnv = process.env): ClaudeSupervisorEnv | undefined {
  const controlDir = env.EVS_CLAUDE_CONTROL_DIR?.trim();
  const runId = env.EVS_CLAUDE_RUN_ID?.trim();
  if (!controlDir || !runId) return undefined;
  const reloadMode = parseReloadMode(env.EVS_CLAUDE_RELOAD_MODE) ?? "manual";
  return { controlDir, runId, reloadMode };
}

export function handshakePathForControlDir(controlDir: string): string {
  return path.join(controlDir, "handshake.json");
}

export function controlLogPathForControlDir(controlDir: string): string {
  return path.join(controlDir, "control.jsonl");
}

export function pendingReloadPathForControlDir(controlDir: string): string {
  return path.join(controlDir, "pending-reload.json");
}

export async function writeSupervisorHandshake(params: {
  controlDir: string;
  handshake: ClaudeSupervisorHandshake;
}): Promise<void> {
  const filePath = handshakePathForControlDir(params.controlDir);
  await writeFileAtomic(filePath, JSON.stringify(params.handshake, null, 2));
}

function tryParseHandshake(value: unknown): ClaudeSupervisorHandshake | undefined {
  if (!isJsonObject(value)) return undefined;
  const runId = asString(value.runId);
  const sessionId = asString(value.sessionId);
  const transcriptPath = asString(value.transcriptPath);
  const ts = asString(value.ts);
  if (!runId || !sessionId || !transcriptPath || !ts) return undefined;
  return { runId, sessionId, transcriptPath, ts };
}

export async function readSupervisorHandshake(controlDir: string): Promise<ClaudeSupervisorHandshake | undefined> {
  const filePath = handshakePathForControlDir(controlDir);
  if (!(await fileExists(filePath))) return undefined;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const obj: unknown = JSON.parse(text);
    return tryParseHandshake(obj);
  } catch {
    return undefined;
  }
}

function tryParsePendingReload(value: unknown): ClaudeSupervisorPendingReload | undefined {
  if (!isJsonObject(value)) return undefined;
  const ts = asString(value.ts);
  const reason = asString(value.reason);
  if (!ts || !reason) return undefined;
  return { ts, reason };
}

export async function readPendingReload(controlDir: string): Promise<ClaudeSupervisorPendingReload | undefined> {
  const filePath = pendingReloadPathForControlDir(controlDir);
  if (!(await fileExists(filePath))) return undefined;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const obj: unknown = JSON.parse(text);
    return tryParsePendingReload(obj);
  } catch {
    return undefined;
  }
}

export async function writePendingReload(params: {
  controlDir: string;
  pending: ClaudeSupervisorPendingReload;
}): Promise<void> {
  const filePath = pendingReloadPathForControlDir(params.controlDir);
  await writeFileAtomic(filePath, JSON.stringify(params.pending, null, 2));
}

export async function clearPendingReload(controlDir: string): Promise<void> {
  const filePath = pendingReloadPathForControlDir(controlDir);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

export async function appendSupervisorControlCommand(params: {
  controlDir: string;
  command: ClaudeSupervisorControlCommand;
}): Promise<void> {
  const filePath = controlLogPathForControlDir(params.controlDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(params.command) + "\n", "utf8");
}

function tryParseControlCommand(value: unknown): ClaudeSupervisorControlCommand | undefined {
  if (!isJsonObject(value)) return undefined;
  const ts = asString(value.ts);
  const cmd = asString(value.cmd);
  const reason = asString(value.reason);
  if (!ts || !cmd || !reason) return undefined;
  if (cmd !== "reload") return undefined;
  return { ts, cmd: "reload", reason };
}

export function parseSupervisorControlCommandLine(line: string): ClaudeSupervisorControlCommand | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const obj: unknown = JSON.parse(trimmed);
    return tryParseControlCommand(obj);
  } catch {
    return undefined;
  }
}
