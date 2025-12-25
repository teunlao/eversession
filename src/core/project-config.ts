import * as fs from "node:fs/promises";
import * as path from "node:path";

import { fileExists, writeFileAtomic } from "./fs.js";
import { asBoolean, asString, isJsonObject } from "./json.js";

export type EvsCodexReloadMode = "manual" | "auto" | "off";

export type EvsCodexAutoCompactConfig = {
  enabled?: boolean;
  threshold?: string;
  amountTokens?: string;
  amountMessages?: string;
  model?: string;
  busyTimeout?: string;
};

export type EvsCodexProjectConfig = {
  reload?: EvsCodexReloadMode;
  autoCompact?: EvsCodexAutoCompactConfig;
};

export type EvsProjectConfigV1 = {
  schemaVersion: 1;
  codex?: EvsCodexProjectConfig;
};

export type EvsProjectConfig = EvsProjectConfigV1;

export function defaultEvsProjectConfig(): EvsProjectConfig {
  return {
    schemaVersion: 1,
    codex: {
      reload: "auto",
      autoCompact: {
        enabled: true,
        threshold: "70%",
        amountTokens: "40%",
        model: "haiku",
        busyTimeout: "10s",
      },
    },
  };
}

export function evsConfigPathForDir(dir: string): string {
  return path.join(dir, ".evs", "config.json");
}

export async function findEvsConfigPath(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 50; i += 1) {
    const candidate = evsConfigPathForDir(dir);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseReloadMode(value: unknown): EvsCodexReloadMode | undefined {
  const v = asString(value)?.trim();
  if (!v) return undefined;
  if (v === "manual" || v === "auto" || v === "off") return v;
  return undefined;
}

function parseCodexAutoCompactConfig(value: unknown): EvsCodexAutoCompactConfig | undefined {
  if (!isJsonObject(value)) return undefined;

  const enabled = asBoolean(value.enabled);
  const threshold = asString(value.threshold)?.trim();
  const amountTokens = asString(value.amountTokens)?.trim();
  const amountMessages = asString(value.amountMessages)?.trim();
  const model = asString(value.model)?.trim();
  const busyTimeout = asString(value.busyTimeout)?.trim();

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(threshold ? { threshold } : {}),
    ...(amountTokens ? { amountTokens } : {}),
    ...(amountMessages ? { amountMessages } : {}),
    ...(model ? { model } : {}),
    ...(busyTimeout ? { busyTimeout } : {}),
  };
}

function parseCodexProjectConfig(value: unknown): EvsCodexProjectConfig | undefined {
  if (!isJsonObject(value)) return undefined;

  const reload = parseReloadMode(value.reload);
  const autoCompact = parseCodexAutoCompactConfig(value.autoCompact);

  return {
    ...(reload ? { reload } : {}),
    ...(autoCompact ? { autoCompact } : {}),
  };
}

export function parseEvsProjectConfig(value: unknown): EvsProjectConfig | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;

  const codex = parseCodexProjectConfig(value.codex);
  return {
    schemaVersion: 1,
    ...(codex ? { codex } : {}),
  };
}

export async function loadEvsProjectConfig(startDir: string): Promise<{ config: EvsProjectConfig; configPath: string } | undefined> {
  const configPath = await findEvsConfigPath(startDir);
  if (!configPath) return undefined;

  const text = await fs.readFile(configPath, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in EVS config: ${configPath}`);
  }

  const parsed = parseEvsProjectConfig(obj);
  if (!parsed) throw new Error(`Unrecognized EVS config format: ${configPath}`);
  return { config: parsed, configPath };
}

export async function writeEvsProjectConfig(params: { configPath: string; config: EvsProjectConfig }): Promise<void> {
  const dir = path.dirname(params.configPath);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(params.configPath, JSON.stringify(params.config, null, 2) + "\n");
}

