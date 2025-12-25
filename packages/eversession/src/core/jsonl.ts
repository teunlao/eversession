import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as readline from "node:readline";

export type JsonlLine =
  | {
      kind: "json";
      line: number;
      raw: string;
      value: unknown;
    }
  | {
      kind: "invalid_json";
      line: number;
      raw: string;
      error: string;
    };

export async function* readJsonlLines(path: string): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo += 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      yield { kind: "json", line: lineNo, raw: rawLine, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { kind: "invalid_json", line: lineNo, raw: rawLine, error: message };
    }
  }
}

export async function loadJsonlFile(path: string): Promise<JsonlLine[]> {
  const out: JsonlLine[] = [];
  for await (const line of readJsonlLines(path)) out.push(line);
  return out;
}

export function stringifyJsonl(values: unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join("\n") + "\n";
}

export async function writeJsonlFile(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, stringifyJsonl(values), "utf8");
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
