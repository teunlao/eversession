import { asString, isJsonObject } from "../../core/json.js";
import type { CleanResult } from "../adapter.js";
import type { CleanParams } from "../clean.js";
import { removeCodexLines } from "./ops.js";
import type { CodexLegacyRecordLine, CodexSession, CodexWrappedLine } from "./session.js";
import { getCodexMessageText, getCodexReasoningText } from "./text.js";

function containsAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return true;
  }
  return false;
}

function findCodexLinesMatching(session: CodexSession, keywords: string[]): Set<number> {
  const out = new Set<number>();

  if (session.format === "wrapped") {
    const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
    for (const line of wrapped) {
      if (line.type !== "response_item") continue;
      if (!isJsonObject(line.payload)) continue;
      const t = asString(line.payload.type);
      if (t === "message") {
        const text = getCodexMessageText(line.payload);
        if (text && containsAny(text, keywords)) out.add(line.line);
      } else if (t === "reasoning") {
        const text = getCodexReasoningText(line.payload);
        if (text && containsAny(text, keywords)) out.add(line.line);
      }
    }
    return out;
  }

  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");
  for (const line of records) {
    if (asString(line.value.record_type)) continue;
    const t = asString(line.value.type);
    if (t === "message") {
      const text = getCodexMessageText(line.value);
      if (text && containsAny(text, keywords)) out.add(line.line);
    } else if (t === "reasoning") {
      const text = getCodexReasoningText(line.value);
      if (text && containsAny(text, keywords)) out.add(line.line);
    }
  }
  return out;
}

export function cleanCodexSession(session: CodexSession, params: CleanParams): CleanResult {
  const initial = findCodexLinesMatching(session, params.keywords);
  if (initial.size === 0) return { matched: 0 };

  const op = removeCodexLines(session, initial, { preserveCallPairs: true });

  return { matched: initial.size, op };
}
