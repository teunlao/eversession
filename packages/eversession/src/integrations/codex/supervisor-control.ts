import * as fs from "node:fs/promises";
import * as path from "node:path";

import { BRAND } from "../../core/brand.js";
import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";

export type ReloadMode = "manual" | "auto" | "off";

export type CodexSupervisorEnv = {
  controlDir: string;
  runId: string;
  reloadMode: ReloadMode;
};

export type CodexSupervisorHandshake = {
  runId: string;
  threadId: string;
  cwd: string;
  ts: string;
  turnId?: string;
};

export type CodexSupervisorControlCommand = {
  ts: string;
  cmd: "reload";
  reason: string;
};

export function parseReloadMode(value: string | undefined): ReloadMode | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "manual" || trimmed === "auto" || trimmed === "off") return trimmed;
  return undefined;
}

export function readCodexSupervisorEnv(env: NodeJS.ProcessEnv = process.env): CodexSupervisorEnv | undefined {
  const controlDir = env[BRAND.env.codex.controlDir]?.trim();
  const runId = env[BRAND.env.codex.runId]?.trim();
  if (!controlDir || !runId) return undefined;
  const reloadMode = parseReloadMode(env[BRAND.env.codex.reloadMode]) ?? "manual";
  return { controlDir, runId, reloadMode };
}

export function handshakePathForControlDir(controlDir: string): string {
  return path.join(controlDir, "handshake.json");
}

export function controlLogPathForControlDir(controlDir: string): string {
  return path.join(controlDir, "control.jsonl");
}

export async function writeSupervisorHandshake(params: {
  controlDir: string;
  handshake: CodexSupervisorHandshake;
}): Promise<void> {
  const filePath = handshakePathForControlDir(params.controlDir);
  await writeFileAtomic(filePath, JSON.stringify(params.handshake, null, 2));
}

function tryParseHandshake(value: unknown): CodexSupervisorHandshake | undefined {
  if (!isJsonObject(value)) return undefined;
  const runId = asString(value.runId);
  const threadId = asString(value.threadId);
  const cwd = asString(value.cwd);
  const ts = asString(value.ts);
  const turnId = asString(value.turnId);
  if (!runId || !threadId || !cwd || !ts) return undefined;
  const out: CodexSupervisorHandshake = { runId, threadId, cwd, ts };
  if (turnId) out.turnId = turnId;
  return out;
}

export async function readSupervisorHandshake(controlDir: string): Promise<CodexSupervisorHandshake | undefined> {
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

export async function appendSupervisorControlCommand(params: {
  controlDir: string;
  command: CodexSupervisorControlCommand;
}): Promise<void> {
  const filePath = controlLogPathForControlDir(params.controlDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(params.command) + "\n", "utf8");
}

function tryParseControlCommand(value: unknown): CodexSupervisorControlCommand | undefined {
  if (!isJsonObject(value)) return undefined;
  const ts = asString(value.ts);
  const cmd = asString(value.cmd);
  const reason = asString(value.reason);
  if (!ts || !cmd || !reason) return undefined;
  if (cmd !== "reload") return undefined;
  return { ts, cmd: "reload", reason };
}

export function parseSupervisorControlCommandLine(line: string): CodexSupervisorControlCommand | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const obj: unknown = JSON.parse(trimmed);
    return tryParseControlCommand(obj);
  } catch {
    return undefined;
  }
}
