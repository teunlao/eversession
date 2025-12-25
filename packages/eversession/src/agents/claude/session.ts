import type { Issue } from "../../core/issues.js";
import { isJsonObject } from "../../core/json.js";
import { type JsonlLine, loadJsonlFile } from "../../core/jsonl.js";

export type ClaudeEntryLine = {
  kind: "entry";
  line: number;
  raw: string;
  value: Record<string, unknown>;
  synthetic?: true;
};

export type ClaudeInvalidJsonLine = {
  kind: "invalid_json";
  line: number;
  raw: string;
  error: string;
};

export type ClaudeLine = ClaudeEntryLine | ClaudeInvalidJsonLine;

export type ClaudeSession = {
  path: string;
  lines: ClaudeLine[];
};

function parseClaudeJsonlLines(path: string, jsonl: JsonlLine[]): { session?: ClaudeSession; issues: Issue[] } {
  const issues: Issue[] = [];
  const lines: ClaudeLine[] = [];

  for (const line of jsonl) {
    if (line.kind === "invalid_json") {
      lines.push({ kind: "invalid_json", line: line.line, raw: line.raw, error: line.error });
      continue;
    }

    const value = line.value;
    if (!isJsonObject(value)) {
      issues.push({
        severity: "warning",
        code: "claude.non_object_line",
        message: "[Claude] JSON line is not an object; Claude Code will ignore it.",
        location: { kind: "line", path, line: line.line },
      });
      continue;
    }

    lines.push({ kind: "entry", line: line.line, raw: line.raw, value });
  }

  if (lines.length === 0) {
    issues.push({
      severity: "warning",
      code: "claude.empty_session",
      message: "[Claude] Session file has no JSON objects.",
      location: { kind: "file", path },
    });
  }

  const hasClaudeSignature = lines.some((l) => l.kind === "entry" && typeof l.value.type === "string");
  if (!hasClaudeSignature) {
    issues.push({
      severity: "warning",
      code: "claude.unrecognized_shape",
      message: "[Claude] No known Claude Code entry types found in sample.",
      location: { kind: "file", path },
    });
  }

  return { session: { path, lines }, issues };
}

export async function parseClaudeSession(path: string): Promise<{ session?: ClaudeSession; issues: Issue[] }> {
  const jsonl = await loadJsonlFile(path);
  return parseClaudeJsonlLines(path, jsonl);
}

export function parseClaudeSessionFromValues(
  path: string,
  values: unknown[],
): { session?: ClaudeSession; issues: Issue[] } {
  const jsonl: JsonlLine[] = values.map((value, idx) => ({
    kind: "json",
    line: idx + 1,
    raw: JSON.stringify(value),
    value,
  }));
  return parseClaudeJsonlLines(path, jsonl);
}
