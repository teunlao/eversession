import type { Issue } from "../../core/issues.js";
import { asString, isJsonObject } from "../../core/json.js";
import { type JsonlLine, loadJsonlFile } from "../../core/jsonl.js";

export type CodexFormat = "wrapped" | "legacy";

export type CodexWrappedLine = {
  kind: "wrapped";
  line: number;
  raw: string;
  value: Record<string, unknown>;
  timestamp: string;
  type: string;
  payload: unknown;
};

export type CodexLegacyMetaLine = {
  kind: "legacy_meta";
  line: number;
  raw: string;
  value: Record<string, unknown>;
  id: string;
  timestamp: string;
};

export type CodexLegacyRecordLine = {
  kind: "legacy_record";
  line: number;
  raw: string;
  value: Record<string, unknown>;
};

export type CodexUnknownJsonLine = {
  kind: "unknown_json";
  line: number;
  raw: string;
  value: Record<string, unknown>;
};

export type CodexInvalidJsonLine = {
  kind: "invalid_json";
  line: number;
  raw: string;
  error: string;
};

export type CodexLine =
  | CodexWrappedLine
  | CodexLegacyMetaLine
  | CodexLegacyRecordLine
  | CodexUnknownJsonLine
  | CodexInvalidJsonLine;

export type CodexSession = {
  format: CodexFormat;
  path: string;
  lines: CodexLine[];
};

function detectCodexFormat(lines: JsonlLine[]): CodexFormat | undefined {
  for (const line of lines) {
    if (line.kind === "invalid_json") continue;
    const v = line.value;
    if (!isJsonObject(v)) continue;
    const t = asString(v.type);
    if (typeof v.timestamp === "string" && typeof t === "string" && "payload" in v) return "wrapped";
    if (typeof v.id === "string" && typeof v.timestamp === "string" && t === undefined) return "legacy";
  }
  return undefined;
}

function parseCodexJsonlLines(path: string, jsonl: JsonlLine[]): { session?: CodexSession; issues: Issue[] } {
  const issues: Issue[] = [];
  const format = detectCodexFormat(jsonl);
  if (!format) {
    issues.push({
      severity: "error",
      code: "codex.unrecognized_format",
      message: "[Codex] Unrecognized session format (expected wrapped RolloutLine or legacy meta).",
      location: { kind: "file", path },
    });
    return { issues };
  }

  const lines: CodexLine[] = [];
  let sawLegacyMeta = false;

  for (const line of jsonl) {
    if (line.kind === "invalid_json") {
      lines.push({ kind: "invalid_json", line: line.line, raw: line.raw, error: line.error });
      continue;
    }
    const value = line.value;
    if (!isJsonObject(value)) {
      issues.push({
        severity: "warning",
        code: "codex.non_object_line",
        message: "[Codex] JSON line is not an object; will be ignored by Codex resume.",
        location: { kind: "line", path, line: line.line },
      });
      continue;
    }

    if (format === "wrapped") {
      const ts = asString(value.timestamp);
      const type = asString(value.type);
      if (ts && type) {
        lines.push({
          kind: "wrapped",
          line: line.line,
          raw: line.raw,
          value,
          timestamp: ts,
          type,
          payload: value.payload,
        });
      } else {
        lines.push({ kind: "unknown_json", line: line.line, raw: line.raw, value });
      }
      continue;
    }

    if (!sawLegacyMeta) {
      const id = asString(value.id);
      const ts = asString(value.timestamp);
      if (id && ts) {
        lines.push({ kind: "legacy_meta", line: line.line, raw: line.raw, value, id, timestamp: ts });
        sawLegacyMeta = true;
      } else {
        lines.push({ kind: "unknown_json", line: line.line, raw: line.raw, value });
      }
      continue;
    }

    lines.push({ kind: "legacy_record", line: line.line, raw: line.raw, value });
  }

  return { session: { format, path, lines }, issues };
}

export async function parseCodexSession(path: string): Promise<{ session?: CodexSession; issues: Issue[] }> {
  const jsonl = await loadJsonlFile(path);
  return parseCodexJsonlLines(path, jsonl);
}

export function parseCodexSessionFromValues(
  path: string,
  values: unknown[],
): { session?: CodexSession; issues: Issue[] } {
  const jsonl: JsonlLine[] = values.map((value, idx) => ({
    kind: "json",
    line: idx + 1,
    raw: JSON.stringify(value),
    value,
  }));
  return parseCodexJsonlLines(path, jsonl);
}
