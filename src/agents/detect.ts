import { asString, isJsonObject } from "../core/json.js";
import { readJsonlLines } from "../core/jsonl.js";
import type { DetectResult } from "./types.js";

type SampleItem =
  | { kind: "json"; line: number; value: unknown }
  | { kind: "invalid_json"; line: number; error: string };

async function readSample(path: string, maxItems: number): Promise<SampleItem[]> {
  const out: SampleItem[] = [];
  for await (const line of readJsonlLines(path)) {
    if (line.kind === "invalid_json") out.push({ kind: "invalid_json", line: line.line, error: line.error });
    else out.push({ kind: "json", line: line.line, value: line.value });
    if (out.length >= maxItems) break;
  }
  return out;
}

export async function detectSession(path: string): Promise<DetectResult> {
  const sample = await readSample(path, 25);
  if (sample.length === 0) {
    return { agent: "unknown", confidence: "low", notes: ["empty file"] };
  }
  const notes: string[] = [];
  const firstInvalid = sample.find((s) => s.kind === "invalid_json");
  if (firstInvalid) notes.push(`saw invalid JSON at line ${firstInvalid.line}`);

  for (const item of sample) {
    if (item.kind !== "json") continue;
    const value = item.value;
    if (!isJsonObject(value)) continue;

    const type = asString(value.type);
    const hasTimestamp = typeof value.timestamp === "string";
    const hasPayload = "payload" in value;

    if (hasTimestamp && typeof type === "string" && hasPayload) {
      if (notes.length > 0) return { agent: "codex", format: "wrapped", confidence: "medium", notes };
      return { agent: "codex", format: "wrapped", confidence: "high" };
    }

    if (typeof value.id === "string" && typeof value.timestamp === "string" && type === undefined) {
      if (notes.length > 0) return { agent: "codex", format: "legacy", confidence: "medium", notes };
      return { agent: "codex", format: "legacy", confidence: "high" };
    }

    if (typeof value.sessionId === "string" && typeof value.uuid === "string") {
      if (notes.length > 0) return { agent: "claude", format: "jsonl", confidence: "medium", notes };
      return { agent: "claude", format: "jsonl", confidence: "high" };
    }

    if (
      type &&
      (type === "assistant" ||
        type === "user" ||
        type === "system" ||
        type === "summary" ||
        type === "file-history-snapshot")
    ) {
      notes.push(`matched Claude entry type at line ${item.line}`);
      return { agent: "claude", format: "jsonl", confidence: "medium", notes };
    }
  }

  return {
    agent: "unknown",
    confidence: "low",
    notes: notes.length > 0 ? notes : ["unrecognized JSONL sample (no known signature in first 25 items)"],
  };
}
