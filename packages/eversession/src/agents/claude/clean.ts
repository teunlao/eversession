import type { CleanResult } from "../adapter.js";
import type { CleanParams } from "../clean.js";
import { removeClaudeLines } from "./ops.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import { getClaudeEntryText } from "./text.js";

function containsAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return true;
  }
  return false;
}

function findClaudeLinesMatching(entries: ClaudeEntryLine[], keywords: string[]): Set<number> {
  const out = new Set<number>();
  for (const e of entries) {
    const text = getClaudeEntryText(e);
    if (!text) continue;
    if (containsAny(text, keywords)) out.add(e.line);
  }
  return out;
}

export function cleanClaudeSession(session: ClaudeSession, params: CleanParams): CleanResult {
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const initial = findClaudeLinesMatching(entries, params.keywords);
  if (initial.size === 0) return { matched: 0 };

  const op = removeClaudeLines(session, initial, {
    preserveAssistantTurns: params.preserveTurns ?? true,
    initialReason: "Removed due to keyword match.",
    assistantTurnReason: "Removed to preserve full assistant turn.",
  });

  return { matched: initial.size, op };
}
