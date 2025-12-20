import * as fs from "node:fs/promises";
import * as path from "node:path";

import { fileExists, writeFileAtomic } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";
import { expandHome } from "../../core/paths.js";
import { claudeEversessionBaseDir } from "../claude/paths.js";

export type PinnedAgent = "claude" | "codex";

export type PinnedSession = {
  name: string;
  agent: PinnedAgent;
  sessionId: string;
  sessionPath: string;
  pinnedAt: string;
  sessionMtime?: string;
};

type PinsFileV1 = {
  schemaVersion: 1;
  updatedAt: string;
  pins: PinnedSession[];
};

function parsePinnedSession(value: unknown): PinnedSession | undefined {
  if (!isJsonObject(value)) return undefined;

  const name = asString(value.name)?.trim();
  const agent = asString(value.agent);
  const sessionId = asString(value.sessionId);
  const sessionPath = asString(value.sessionPath);
  const pinnedAt = asString(value.pinnedAt);
  const sessionMtime = asString(value.sessionMtime);

  if (!name || name.length === 0) return undefined;
  if (agent !== "claude" && agent !== "codex") return undefined;
  if (!sessionId || !sessionPath || !pinnedAt) return undefined;

  const out: PinnedSession = { name, agent, sessionId, sessionPath, pinnedAt };
  if (sessionMtime) out.sessionMtime = sessionMtime;
  return out;
}

function parsePinsFile(value: unknown): PinsFileV1 | undefined {
  if (!isJsonObject(value)) return undefined;

  const schemaVersion = value.schemaVersion === 1 ? 1 : undefined;
  if (!schemaVersion) return undefined;

  const pinsRaw = value.pins;
  if (!Array.isArray(pinsRaw)) return undefined;

  const pins: PinnedSession[] = [];
  for (const item of pinsRaw) {
    const parsed = parsePinnedSession(item);
    if (!parsed) continue;
    if (pins.some((p) => p.name === parsed.name)) continue;
    pins.push(parsed);
  }

  return {
    schemaVersion,
    updatedAt: asString(value.updatedAt) ?? new Date().toISOString(),
    pins,
  };
}

export function resolvePinsPath(pinsPathArg?: string | undefined): string {
  const raw = pinsPathArg?.trim() || process.env.EVS_PINS_PATH?.trim();
  const defaultPath = path.join(claudeEversessionBaseDir(), "pins.json");
  const chosen = raw && raw.length > 0 ? raw : defaultPath;
  return path.resolve(expandHome(chosen));
}

export async function loadPinsFile(pinsPath: string): Promise<PinsFileV1> {
  if (!(await fileExists(pinsPath))) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), pins: [] };
  }

  const text = await fs.readFile(pinsPath, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in pins file: ${pinsPath}`);
  }

  const parsed = parsePinsFile(obj);
  if (!parsed) throw new Error(`Unrecognized pins file format: ${pinsPath}`);
  return parsed;
}

export async function savePinsFile(pinsPath: string, pins: PinnedSession[]): Promise<void> {
  const dir = path.dirname(pinsPath);
  await fs.mkdir(dir, { recursive: true });

  const file: PinsFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    pins,
  };

  await writeFileAtomic(pinsPath, JSON.stringify(file, null, 2));
}

