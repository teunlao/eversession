import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileExists } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";
import { parseTokenThreshold } from "../../core/threshold.js";
import { extractClaudeSessionIdFromPayload, resolveClaudeActiveCwd } from "./context.js";
import { loadClaudeSettings, resolveClaudeSettingsPath } from "./settings.js";

function extractString(payload: unknown, keys: string[]): string | undefined {
  const candidates = candidateObjects(payload);
  for (const obj of candidates) {
    for (const key of keys) {
      const direct = asString(obj[key]);
      if (direct && direct.trim().length > 0) return direct;
    }
  }
  return undefined;
}

function candidateObjects(payload: unknown): Array<Record<string, unknown>> {
  if (!isJsonObject(payload)) return [];
  const out: Array<Record<string, unknown>> = [payload];
  const nested = payload.payload;
  if (isJsonObject(nested)) out.push(nested);
  return out;
}

export function defaultStatuslineDumpPath(cwdOverride?: string): string {
  const base = resolveClaudeActiveCwd(cwdOverride);
  return path.join(base, ".evs.statusline.stdin.jsonl");
}

export function extractClaudeStatuslineFields(payload: unknown): { transcriptPath?: string; sessionId?: string } {
  if (!payload) return {};
  const transcriptPath = extractString(payload, ["transcript_path", "transcriptPath"]);
  const sessionId = extractClaudeSessionIdFromPayload(payload);
  return {
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFlagFromCommand(command: string, flagName: string): string | undefined {
  const raw = command.trim();
  if (raw.length === 0) return undefined;

  const escaped = escapeRegExp(flagName);
  const eq = raw.match(new RegExp(`(?:^|\\s)--${escaped}=([^\\s]+)`));
  if (eq?.[1]) return eq[1];

  const spaced = raw.match(new RegExp(`(?:^|\\s)--${escaped}\\s+([^\\s]+)`));
  if (spaced?.[1]) return spaced[1];

  return undefined;
}

export function isEvsStatuslineCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0) return false;
  return normalized.includes("evs statusline");
}

export async function readAutoCompactThresholdFromProjectSettings(projectDir: string): Promise<number | undefined> {
  const settingsPath = resolveClaudeSettingsPath({ global: false, cwd: projectDir });
  if (!(await fileExists(settingsPath))) return undefined;

  const parsed = await loadClaudeSettings(settingsPath);
  if (!isJsonObject(parsed)) return undefined;

  const hooks = parsed.hooks;
  if (!isJsonObject(hooks)) return undefined;

  const stop = hooks.Stop;
  if (!Array.isArray(stop)) return undefined;

  const thresholds: number[] = [];
  for (const item of stop) {
    if (!isJsonObject(item)) continue;
    const innerHooks = item.hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const h of innerHooks) {
      if (!isJsonObject(h)) continue;
      const cmd = asString(h.command);
      if (!cmd) continue;
      if (!cmd.includes("evs auto-compact start")) continue;
      const thresholdFlag = parseFlagFromCommand(cmd, "threshold");
      if (!thresholdFlag) continue;
      try {
        thresholds.push(parseTokenThreshold(thresholdFlag));
      } catch {
        // ignore invalid threshold strings
      }
    }
  }

  if (thresholds.length === 0) return undefined;
  const first = thresholds[0];
  if (first === undefined) return undefined;
  for (const t of thresholds) {
    if (t !== first) return undefined;
  }
  return first;
}

function uniqueStringOrUndefined(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (filtered.length === 0) return undefined;
  const first = filtered[0];
  if (!first) return undefined;
  for (const v of filtered) {
    if (v !== first) return undefined;
  }
  return first;
}

function uniqueNumberOrUndefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (filtered.length === 0) return undefined;
  const first = filtered[0];
  if (first === undefined) return undefined;
  for (const v of filtered) {
    if (v !== first) return undefined;
  }
  return first;
}

export type AutoCompactHookConfig = {
  thresholdTokens?: number;
  amount?: string;
  amountTokens?: string;
  amountMessages?: string;
  keepLast?: string;
  maxTokens?: string;
  model?: string;
  busyTimeout?: string;
};

export async function readAutoCompactConfigFromProjectSettings(
  projectDir: string,
): Promise<AutoCompactHookConfig | undefined> {
  const settingsPath = resolveClaudeSettingsPath({ global: false, cwd: projectDir });
  if (!(await fileExists(settingsPath))) return undefined;

  const parsed = await loadClaudeSettings(settingsPath);
  if (!isJsonObject(parsed)) return undefined;

  const hooks = parsed.hooks;
  if (!isJsonObject(hooks)) return undefined;

  const stop = hooks.Stop;
  if (!Array.isArray(stop)) return undefined;

  const thresholds: Array<number | undefined> = [];
  const amounts: Array<string | undefined> = [];
  const amountTokens: Array<string | undefined> = [];
  const amountMessages: Array<string | undefined> = [];
  const keepLast: Array<string | undefined> = [];
  const maxTokens: Array<string | undefined> = [];
  const models: Array<string | undefined> = [];
  const busyTimeouts: Array<string | undefined> = [];

  for (const item of stop) {
    if (!isJsonObject(item)) continue;
    const innerHooks = item.hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const h of innerHooks) {
      if (!isJsonObject(h)) continue;
      const cmd = asString(h.command);
      if (!cmd) continue;
      if (!cmd.includes("evs auto-compact start")) continue;

      const thresholdFlag = parseFlagFromCommand(cmd, "threshold");
      if (thresholdFlag) {
        try {
          thresholds.push(parseTokenThreshold(thresholdFlag));
        } catch {
          thresholds.push(undefined);
        }
      }

      amounts.push(parseFlagFromCommand(cmd, "amount"));
      amountTokens.push(parseFlagFromCommand(cmd, "amount-tokens"));
      amountMessages.push(parseFlagFromCommand(cmd, "amount-messages"));
      keepLast.push(parseFlagFromCommand(cmd, "keep-last"));
      maxTokens.push(parseFlagFromCommand(cmd, "max-tokens"));
      models.push(parseFlagFromCommand(cmd, "model"));
      busyTimeouts.push(parseFlagFromCommand(cmd, "busy-timeout"));
    }
  }

  const thresholdTokens = uniqueNumberOrUndefined(thresholds);
  const amount = uniqueStringOrUndefined(amounts);
  const amountTokensValue = uniqueStringOrUndefined(amountTokens);
  const amountMessagesValue = uniqueStringOrUndefined(amountMessages);
  const keepLastValue = uniqueStringOrUndefined(keepLast);
  const maxTokensValue = uniqueStringOrUndefined(maxTokens);
  const model = uniqueStringOrUndefined(models);
  const busyTimeout = uniqueStringOrUndefined(busyTimeouts);

  return {
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    ...(amount ? { amount } : {}),
    ...(amountTokensValue ? { amountTokens: amountTokensValue } : {}),
    ...(amountMessagesValue ? { amountMessages: amountMessagesValue } : {}),
    ...(keepLastValue ? { keepLast: keepLastValue } : {}),
    ...(maxTokensValue ? { maxTokens: maxTokensValue } : {}),
    ...(model ? { model } : {}),
    ...(busyTimeout ? { busyTimeout } : {}),
  };
}

export type AutoCompactLogEntry = {
  ts?: string;
  event?: string;
  result?: string;
  usedModel?: string;
  threshold?: number;
  amount?: unknown;
  keepLast?: unknown;
  tokens?: number;
  tokensAfter?: number;
};

export type AutoCompactStartLogEntry = {
  ts?: string;
  event?: string;
  threshold?: number;
};

export type SessionStartLogEntry = {
  ts?: string;
  event?: string;
  hookEventName?: string;
};

export async function readClaudeAutoCompactSignals(logPath: string): Promise<{
  lastResult?: AutoCompactLogEntry;
  lastStart?: AutoCompactStartLogEntry;
  lastSuccess?: AutoCompactLogEntry;
  lastSessionStart?: SessionStartLogEntry;
}> {
  if (!(await fileExists(logPath))) return {};

  // Read last 128KB to find the last auto_compact entry.
  const maxBytes = 128 * 1024;
  let size = 0;
  try {
    const st = await fs.stat(logPath);
    size = st.size;
  } catch {
    return {};
  }

  const start = Math.max(0, size - maxBytes);
  let buf: Buffer;
  try {
    const fh = await fs.open(logPath, "r");
    try {
      const len = size - start;
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
    } finally {
      await fh.close();
    }
  } catch {
    return {};
  }

  const text = buf.toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  let lastResult: AutoCompactLogEntry | undefined;
  let lastStart: AutoCompactStartLogEntry | undefined;
  let lastSuccess: AutoCompactLogEntry | undefined;
  let lastSessionStart: SessionStartLogEntry | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastResult && lastStart && lastSuccess && lastSessionStart) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (!isJsonObject(obj)) continue;
      const ev = asString(obj.event);
      if (!lastResult && ev === "auto_compact") {
        const ts = asString(obj.ts);
        const result = asString(obj.result);
        const usedModel = asString(obj.usedModel);
        lastResult = {
          event: ev,
          ...(ts ? { ts } : {}),
          ...(result ? { result } : {}),
          ...(usedModel ? { usedModel } : {}),
          ...(typeof obj.threshold === "number" ? { threshold: obj.threshold } : {}),
          ...(typeof obj.tokens === "number" ? { tokens: obj.tokens } : {}),
          ...(typeof obj.tokensAfter === "number" ? { tokensAfter: obj.tokensAfter } : {}),
          ...("amount" in obj ? { amount: obj.amount } : {}),
          ...("keepLast" in obj ? { keepLast: obj.keepLast } : {}),
        };
      }

      if (!lastSuccess && ev === "auto_compact" && asString(obj.result) === "success") {
        const ts = asString(obj.ts);
        const result = asString(obj.result);
        const usedModel = asString(obj.usedModel);
        lastSuccess = {
          event: ev,
          ...(ts ? { ts } : {}),
          ...(result ? { result } : {}),
          ...(usedModel ? { usedModel } : {}),
          ...(typeof obj.threshold === "number" ? { threshold: obj.threshold } : {}),
          ...(typeof obj.tokens === "number" ? { tokens: obj.tokens } : {}),
          ...(typeof obj.tokensAfter === "number" ? { tokensAfter: obj.tokensAfter } : {}),
          ...("amount" in obj ? { amount: obj.amount } : {}),
          ...("keepLast" in obj ? { keepLast: obj.keepLast } : {}),
        };
      }

      if (!lastStart && ev === "auto_compact_start") {
        const ts = asString(obj.ts);
        lastStart = {
          event: ev,
          ...(ts ? { ts } : {}),
          ...(typeof obj.threshold === "number" ? { threshold: obj.threshold } : {}),
        };
      }

      if (!lastSessionStart && ev === "session_start") {
        const ts = asString(obj.ts);
        const hookEventName = asString(obj.hookEventName);
        lastSessionStart = {
          event: ev,
          ...(ts ? { ts } : {}),
          ...(hookEventName ? { hookEventName } : {}),
        };
      }
    } catch {
      // ignore
    }
  }
  return {
    ...(lastResult ? { lastResult } : {}),
    ...(lastStart ? { lastStart } : {}),
    ...(lastSuccess ? { lastSuccess } : {}),
    ...(lastSessionStart ? { lastSessionStart } : {}),
  };
}
