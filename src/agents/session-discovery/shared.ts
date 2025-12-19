import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";

import { readJsonlLines } from "../../core/jsonl.js";
import { asString, isJsonObject } from "../../core/json.js";
import { fileExists } from "../../core/fs.js";

export async function normalizeCwdCandidates(cwdInput: string): Promise<string[]> {
  const out: string[] = [];
  const pushUnique = (v: string): void => {
    if (!out.includes(v)) out.push(v);
  };

  pushUnique(cwdInput);
  try {
    const real = await fs.realpath(cwdInput);
    pushUnique(real);
  } catch {
    // ignore
  }
  return out;
}

export async function readJsonlHead(
  filePath: string,
  maxLines: number,
): Promise<{ jsonObjects: Record<string, unknown>[]; invalidJsonLines: number }> {
  const jsonObjects: Record<string, unknown>[] = [];
  let invalidJsonLines = 0;

  for await (const line of readJsonlLines(filePath)) {
    if (line.kind === "invalid_json") {
      invalidJsonLines += 1;
    } else if (isJsonObject(line.value)) {
      jsonObjects.push(line.value);
    }
    if (jsonObjects.length + invalidJsonLines >= maxLines) break;
  }

  return { jsonObjects, invalidJsonLines };
}

export async function readJsonlTail(
  filePath: string,
  tailLines: number,
): Promise<{
  tail: Array<{ kind: "json"; line: number; value: unknown } | { kind: "invalid_json"; line: number; error: string }>;
  invalidJsonLines: number;
}> {
  const buffer: Array<
    { kind: "json"; line: number; value: unknown } | { kind: "invalid_json"; line: number; error: string }
  > = [];
  let invalidJsonLines = 0;

  for await (const line of readJsonlLines(filePath)) {
    if (line.kind === "invalid_json") {
      invalidJsonLines += 1;
      buffer.push({ kind: "invalid_json", line: line.line, error: line.error });
    } else {
      buffer.push({ kind: "json", line: line.line, value: line.value });
    }
    if (buffer.length > tailLines) buffer.shift();
  }

  return { tail: buffer, invalidJsonLines };
}

export function maxTimestampIso(values: unknown[]): string | undefined {
  let max: number | undefined;
  let maxIso: string | undefined;
  for (const value of values) {
    if (!isJsonObject(value)) continue;
    const ts = asString(value.timestamp);
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    if (max === undefined || ms > max) {
      max = ms;
      maxIso = ts;
    }
  }
  return maxIso;
}

export function matchInTailRaw(
  tail: Array<{ kind: "json"; line: number; value: unknown } | { kind: "invalid_json"; line: number; error: string }>,
  text: string,
): boolean {
  const needle = text.toLowerCase();
  for (const t of tail) {
    if (t.kind !== "json") continue;
    const raw = JSON.stringify(t.value).toLowerCase();
    if (raw.includes(needle)) return true;
  }
  return false;
}

export async function listDirs(baseDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export async function listFiles(baseDir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
}
