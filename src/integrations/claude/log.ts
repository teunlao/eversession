import { asString, isJsonObject } from "../../core/json.js";

export type AutoCompactLogEntry = {
  ts?: string;
  event?: string;
  result?: string;
  amountMode?: string;
  amount?: unknown;
  keepLast?: unknown;
  threshold?: number;
  tokens?: number;
  tokensAfter?: number | null;
  model?: string;
};

function formatK(value: number | undefined | null): string {
  if (value === undefined || value === null) return "?";
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  if (k < 10) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}

function formatAmount(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseAutoCompactEntry(line: string): AutoCompactLogEntry | undefined {
  try {
    const obj: unknown = JSON.parse(line);
    if (!isJsonObject(obj)) return undefined;
    if (asString(obj.event) !== "auto_compact") return undefined;
    const entry: AutoCompactLogEntry = {};
    const ts = asString(obj.ts);
    if (ts) entry.ts = ts;
    const event = asString(obj.event);
    if (event) entry.event = event;
    const result = asString(obj.result);
    if (result) entry.result = result;
    const amountMode = asString(obj.amountMode);
    if (amountMode) entry.amountMode = amountMode;
    if ("amount" in obj) entry.amount = obj.amount;
    if ("keepLast" in obj) entry.keepLast = obj.keepLast;
    if (typeof obj.threshold === "number") entry.threshold = obj.threshold;
    if (typeof obj.tokens === "number") entry.tokens = obj.tokens;
    if (typeof obj.tokensAfter === "number" || obj.tokensAfter === null) {
      entry.tokensAfter = obj.tokensAfter as number | null;
    }
    const model = asString(obj.model);
    if (model) entry.model = model;
    return entry;
  } catch {
    return undefined;
  }
}

export function parseClaudeAutoCompactEntries(raw: string): AutoCompactLogEntry[] {
  const entries: AutoCompactLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseAutoCompactEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function formatClaudeAutoCompactLine(entry: AutoCompactLogEntry): string {
  const ts = entry.ts ?? "?";
  const result = entry.result ?? "?";
  const tokens = formatK(entry.tokens);
  const tokensAfter =
    entry.tokensAfter === undefined ? "" : entry.tokensAfter === null ? "->?" : `->${formatK(entry.tokensAfter)}`;
  const threshold = formatK(entry.threshold);
  const amount = formatAmount(entry.amount);
  const amountMode = entry.amountMode;
  const model = entry.model;
  const keepLast = formatAmount(entry.keepLast);

  const parts: string[] = [`${ts}`, `result=${result}`, `tokens=${tokens}${tokensAfter}`, `threshold=${threshold}`];
  if (amount) parts.push(`amount=${amount}`);
  if (amountMode) parts.push(`mode=${amountMode}`);
  if (keepLast) parts.push(`keepLast=${keepLast}`);
  if (model) parts.push(`model=${model}`);
  return parts.join(" ");
}
