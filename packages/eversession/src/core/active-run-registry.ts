import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { fileExists, writeFileAtomic } from "./fs.js";
import { asNumber, asString, isJsonObject } from "./json.js";
import { evsGlobalConfigPath } from "./project-config.js";

export type EvsActiveRunAgent = "claude" | "codex";

export type EvsActiveRunRecordV1 = {
  schemaVersion: 1;
  agent: EvsActiveRunAgent;
  runId: string;
  pid: number;
  controlDir: string;
  cwd: string;
  reloadMode: "manual" | "auto" | "off";
  startedAt: string;
};

export type EvsActiveRunRecord = EvsActiveRunRecordV1;

export function evsGlobalRootDir(): string {
  return path.dirname(evsGlobalConfigPath());
}

export function evsActiveRunsDir(): string {
  return path.join(evsGlobalRootDir(), "active");
}

export function activeRunRecordPath(agent: EvsActiveRunAgent, runId: string): string {
  return path.join(evsActiveRunsDir(), `${agent}-${runId}.json`);
}

export function isEvsControlDirForAgent(controlDir: string, agent: EvsActiveRunAgent): boolean {
  const expectedPrefix = path.join(os.tmpdir(), agent === "claude" ? "evs-claude" : "evs-codex") + path.sep;
  const resolved = path.resolve(controlDir) + path.sep;
  return resolved.startsWith(expectedPrefix);
}

export async function writeActiveRunRecord(record: EvsActiveRunRecord): Promise<void> {
  await fs.mkdir(evsActiveRunsDir(), { recursive: true });
  const filePath = activeRunRecordPath(record.agent, record.runId);
  await writeFileAtomic(filePath, JSON.stringify(record, null, 2) + "\n");
}

export async function removeActiveRunRecord(agent: EvsActiveRunAgent, runId: string): Promise<void> {
  const filePath = activeRunRecordPath(agent, runId);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

export async function listActiveRunRecordPaths(): Promise<string[]> {
  const dir = evsActiveRunsDir();
  if (!(await fileExists(dir))) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

function tryParseActiveRunRecord(value: unknown): EvsActiveRunRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  const agentRaw = asString(value.agent);
  const agent = agentRaw === "claude" || agentRaw === "codex" ? (agentRaw satisfies EvsActiveRunAgent) : undefined;
  if (!agent) return undefined;
  const runId = asString(value.runId);
  const pid = asNumber(value.pid);
  const controlDir = asString(value.controlDir);
  const cwd = asString(value.cwd);
  const reloadModeRaw = asString(value.reloadMode);
  const reloadMode =
    reloadModeRaw === "manual" || reloadModeRaw === "auto" || reloadModeRaw === "off"
      ? (reloadModeRaw satisfies EvsActiveRunRecord["reloadMode"])
      : undefined;
  const startedAt = asString(value.startedAt);
  if (!runId || pid === undefined || !controlDir || !cwd || !reloadMode || !startedAt) return undefined;
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  return { schemaVersion: 1, agent, runId, pid: Math.floor(pid), controlDir, cwd, reloadMode, startedAt };
}

export async function readActiveRunRecordFile(filePath: string): Promise<EvsActiveRunRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  return tryParseActiveRunRecord(obj);
}

export function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = check existence, no kill.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
