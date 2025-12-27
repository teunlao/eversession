import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { fileExists, writeFileAtomic } from "./fs.js";
import { asBoolean, asString, isJsonObject } from "./json.js";

export type EvsReloadMode = "manual" | "auto" | "off";

export type EvsAutoCompactConfig = {
  enabled?: boolean;
  /** Claude: absolute tokens (e.g. "140k"). Codex: tokens/percent (e.g. "70%"). */
  threshold?: string;
  amountTokens?: string;
  amountMessages?: string;
  keepLast?: string;
  maxTokens?: string;
  model?: string;
  busyTimeout?: string;
  notify?: boolean;
  backup?: boolean;
};

export type EvsAgentConfig = {
  reload?: EvsReloadMode;
  autoCompact?: EvsAutoCompactConfig;
};

export type EvsConfigV1 = {
  schemaVersion: 1;
  /** When true, write operations create a backup unless overridden by a flag. */
  backup?: boolean;
  claude?: EvsAgentConfig;
  codex?: EvsAgentConfig;
};

export type EvsConfig = EvsConfigV1;

export type EvsConfigValueSource = "default" | "global" | "local";

export type ResolvedEvsConfig = {
  config: EvsConfig;
  files: {
    global: { path: string; exists: boolean };
    local: { path: string; exists: boolean; discovered: boolean };
  };
  sourceByPath: Record<string, EvsConfigValueSource>;
};

export function defaultEvsConfig(): EvsConfig {
  return {
    schemaVersion: 1,
    backup: false,
    claude: {
      reload: "manual",
      autoCompact: {
        enabled: true,
        threshold: "120k",
        amountTokens: "40%",
        amountMessages: "25%",
        model: "haiku",
        busyTimeout: "10s",
        notify: false,
        backup: false,
      },
    },
    codex: {
      reload: "manual",
      autoCompact: {
        enabled: true,
        threshold: "70%",
        amountTokens: "40%",
        amountMessages: "35%",
        model: "haiku",
        busyTimeout: "10s",
        notify: false,
        backup: false,
      },
    },
  };
}

export function evsLocalConfigPathForDir(dir: string): string {
  return path.join(dir, ".evs", "config.json");
}

export function evsGlobalConfigPath(): string {
  const override = process.env.EVS_CONFIG_PATH?.trim();
  if (override && override.length > 0) {
    if (override === "~") return path.join(os.homedir(), ".evs", "config.json");
    if (override.startsWith("~/")) return path.join(os.homedir(), override.slice(2));
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".evs", "config.json");
}

function isSamePath(a: string, b: string): boolean {
  const aResolved = path.resolve(a);
  const bResolved = path.resolve(b);
  if (process.platform === "win32") return aResolved.toLowerCase() === bResolved.toLowerCase();
  return aResolved === bResolved;
}

export async function findEvsConfigPath(startDir: string): Promise<string | undefined> {
  const globalConfigPath = evsGlobalConfigPath();
  let dir = path.resolve(startDir);
  for (let i = 0; i < 50; i += 1) {
    const candidate = evsLocalConfigPathForDir(dir);
    if (!isSamePath(candidate, globalConfigPath) && (await fileExists(candidate))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseReloadMode(value: unknown): EvsReloadMode | undefined {
  const v = asString(value)?.trim();
  if (!v) return undefined;
  if (v === "manual" || v === "auto" || v === "off") return v;
  return undefined;
}

function parseAutoCompactConfig(value: unknown): EvsAutoCompactConfig | undefined {
  if (!isJsonObject(value)) return undefined;

  const enabled = asBoolean(value.enabled);
  const threshold = asString(value.threshold)?.trim();
  const amountTokens = asString(value.amountTokens)?.trim();
  const amountMessages = asString(value.amountMessages)?.trim();
  const keepLast = asString(value.keepLast)?.trim();
  const maxTokens = asString(value.maxTokens)?.trim();
  const model = asString(value.model)?.trim();
  const busyTimeout = asString(value.busyTimeout)?.trim();
  const notify = asBoolean(value.notify);
  const backup = asBoolean(value.backup);

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(threshold ? { threshold } : {}),
    ...(amountTokens ? { amountTokens } : {}),
    ...(amountMessages ? { amountMessages } : {}),
    ...(keepLast ? { keepLast } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(model ? { model } : {}),
    ...(busyTimeout ? { busyTimeout } : {}),
    ...(notify !== undefined ? { notify } : {}),
    ...(backup !== undefined ? { backup } : {}),
  };
}

function parseAgentConfig(value: unknown): EvsAgentConfig | undefined {
  if (!isJsonObject(value)) return undefined;
  const reload = parseReloadMode(value.reload);
  const autoCompact = parseAutoCompactConfig(value.autoCompact);
  return {
    ...(reload ? { reload } : {}),
    ...(autoCompact ? { autoCompact } : {}),
  };
}

export function parseEvsConfig(value: unknown): EvsConfig | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;

  const backup = asBoolean(value.backup);
  const claude = parseAgentConfig(value.claude);
  const codex = parseAgentConfig(value.codex);

  return {
    schemaVersion: 1,
    ...(backup !== undefined ? { backup } : {}),
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
  };
}

type ParseEvsConfigStrictResult = { ok: true; config: EvsConfig } | { ok: false; errors: string[] };

const ROOT_KEYS = new Set<string>(["schemaVersion", "backup", "claude", "codex"]);
const AGENT_KEYS = new Set<string>(["reload", "autoCompact"]);
const AUTO_COMPACT_KEYS = new Set<string>([
  "enabled",
  "threshold",
  "amountTokens",
  "amountMessages",
  "keepLast",
  "maxTokens",
  "model",
  "busyTimeout",
  "notify",
  "backup",
]);

function validateAllowedKeys(obj: JsonRecord, allowed: Set<string>, prefix: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`Unknown field: ${prefix ? `${prefix}.${key}` : key}`);
    }
  }
}

function validateReloadValue(value: unknown, pathLabel: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push(`Invalid value at ${pathLabel} (expected string "manual"|"auto"|"off")`);
    return;
  }
  const v = value.trim();
  if (v !== "manual" && v !== "auto" && v !== "off") {
    errors.push(`Invalid value at ${pathLabel} (expected "manual"|"auto"|"off")`);
  }
}

function validateOptionalBoolean(value: unknown, pathLabel: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") errors.push(`Invalid value at ${pathLabel} (expected boolean)`);
}

function validateOptionalString(value: unknown, pathLabel: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") errors.push(`Invalid value at ${pathLabel} (expected string)`);
}

function validateAutoCompactObject(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`Invalid value at ${prefix} (expected object)`);
    return;
  }
  validateAllowedKeys(value, AUTO_COMPACT_KEYS, prefix, errors);
  validateOptionalBoolean(value.enabled, `${prefix}.enabled`, errors);
  validateOptionalString(value.threshold, `${prefix}.threshold`, errors);
  validateOptionalString(value.amountTokens, `${prefix}.amountTokens`, errors);
  validateOptionalString(value.amountMessages, `${prefix}.amountMessages`, errors);
  validateOptionalString(value.keepLast, `${prefix}.keepLast`, errors);
  validateOptionalString(value.maxTokens, `${prefix}.maxTokens`, errors);
  validateOptionalString(value.model, `${prefix}.model`, errors);
  validateOptionalString(value.busyTimeout, `${prefix}.busyTimeout`, errors);
  validateOptionalBoolean(value.notify, `${prefix}.notify`, errors);
  validateOptionalBoolean(value.backup, `${prefix}.backup`, errors);
}

function validateAgentObject(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`Invalid value at ${prefix} (expected object)`);
    return;
  }
  validateAllowedKeys(value, AGENT_KEYS, prefix, errors);
  validateReloadValue(value.reload, `${prefix}.reload`, errors);
  validateAutoCompactObject(value.autoCompact, `${prefix}.autoCompact`, errors);
}

export function parseEvsConfigStrict(value: unknown): ParseEvsConfigStrictResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Config must be a JSON object."] };

  validateAllowedKeys(value, ROOT_KEYS, "", errors);

  if (value.schemaVersion !== 1) {
    errors.push("Invalid value at schemaVersion (expected number 1).");
  }

  if ("backup" in value) validateOptionalBoolean(value.backup, "backup", errors);
  if ("claude" in value) validateAgentObject(value.claude, "claude", errors);
  if ("codex" in value) validateAgentObject(value.codex, "codex", errors);

  if (errors.length > 0) return { ok: false, errors };

  const parsed = parseEvsConfig(value);
  if (!parsed) return { ok: false, errors: ["Unrecognized EVS config format."] };
  return { ok: true, config: parsed };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const out: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isRecord(existing) && isRecord(value)) out[key] = deepMerge(existing, value);
    else out[key] = value;
  }
  return out;
}

function collectLeafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (!isRecord(value)) {
    out.add(prefix);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    out.add(prefix);
    return;
  }
  for (const [key, v] of entries) {
    const next = prefix ? `${prefix}.${key}` : key;
    collectLeafPaths(v, next, out);
  }
}

function leafPathsOf(value: unknown): Set<string> {
  const out = new Set<string>();
  collectLeafPaths(value, "", out);
  out.delete("");
  return out;
}

async function readConfigFileIfPresent(configPath: string): Promise<EvsConfig | undefined> {
  if (!(await fileExists(configPath))) return undefined;
  const text = await fs.readFile(configPath, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in EVS config: ${configPath}`);
  }

  const strict = parseEvsConfigStrict(obj);
  if (!strict.ok) {
    const bulletList = strict.errors.map((e) => `- ${e}`).join("\n");
    throw new Error(`Invalid EVS config: ${configPath}\n${bulletList}`);
  }
  return strict.config;
}

function applySourcePaths(
  sourceByPath: Record<string, EvsConfigValueSource>,
  partial: EvsConfig,
  source: EvsConfigValueSource,
): void {
  for (const p of leafPathsOf(partial)) sourceByPath[p] = source;
}

export async function resolveEvsConfigForCwd(cwd: string): Promise<ResolvedEvsConfig> {
  const globalPath = evsGlobalConfigPath();
  const localFound = await findEvsConfigPath(cwd);
  const localPath = localFound ?? evsLocalConfigPathForDir(path.resolve(cwd));

  const base = defaultEvsConfig();
  const sourceByPath: Record<string, EvsConfigValueSource> = {};
  for (const p of leafPathsOf(base)) sourceByPath[p] = "default";

  const globalCfg = await readConfigFileIfPresent(globalPath);
  const localCfg = localFound ? await readConfigFileIfPresent(localFound) : undefined;

  let merged: unknown = base;
  if (globalCfg) {
    merged = deepMerge(merged, globalCfg);
    applySourcePaths(sourceByPath, globalCfg, "global");
  }
  if (localCfg) {
    merged = deepMerge(merged, localCfg);
    applySourcePaths(sourceByPath, localCfg, "local");
  }

  return {
    config: merged as EvsConfig,
    files: {
      global: { path: globalPath, exists: globalCfg !== undefined },
      local: { path: localPath, exists: localCfg !== undefined, discovered: localFound !== undefined },
    },
    sourceByPath,
  };
}

export async function writeEvsConfig(params: { configPath: string; config: EvsConfig }): Promise<void> {
  const dir = path.dirname(params.configPath);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(params.configPath, JSON.stringify(params.config, null, 2) + "\n");
}
