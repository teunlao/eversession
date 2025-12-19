import type { Change, ChangeSet } from "../../core/changes.js";
import type { CountOrPercent } from "../../core/spec.js";
import type { ClaudeEntryLine, ClaudeLine, ClaudeSession } from "./session.js";
import { getEntryType } from "./model.js";
import { fixClaudeSession } from "./fix.js";
import { expandToPreserveToolPairs, relinkParentUuidsOnRemoval } from "./remove-utils.js";
import { expandToFullAssistantTurns } from "./turns.js";

export type OpResult = { nextValues: unknown[]; changes: ChangeSet };

export function removeClaudeLines(
  session: ClaudeSession,
  initialLines: Set<number>,
  options?: {
    preserveAssistantTurns?: boolean;
    autoFix?: boolean;
    initialReason?: string;
    assistantTurnReason?: string;
  },
): OpResult {
  const preserveAssistantTurns = options?.preserveAssistantTurns ?? true;
  const autoFix = options?.autoFix ?? true;
  const initialReason = options?.initialReason ?? "Removed by explicit request.";
  const assistantTurnReason = options?.assistantTurnReason ?? "Removed to preserve full assistant turn.";

  const changes: Change[] = [];

  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const requested = new Set(initialLines);
  const beforeTurns = new Set(requested);

  if (preserveAssistantTurns) {
    expandToFullAssistantTurns(entries, requested);
  }

  const reasons = expandToPreserveToolPairs(entries, requested);
  for (const line of initialLines) {
    if (reasons.has(line)) reasons.set(line, initialReason);
  }
  if (preserveAssistantTurns) {
    for (const line of requested) {
      if (beforeTurns.has(line)) continue;
      const current = reasons.get(line);
      if (current === "Selected for removal.") reasons.set(line, assistantTurnReason);
    }
  }

  const toRemove = new Set<number>(reasons.keys());
  relinkParentUuidsOnRemoval(entries, toRemove, changes);

  const filteredLines: ClaudeLine[] = [];
  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: "Dropped invalid JSON line (cannot be preserved in JSONL rewrite).",
      });
      continue;
    }
    if (toRemove.has(line.line)) {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: reasons.get(line.line) ?? "Removed line.",
      });
      continue;
    }
    filteredLines.push(line);
  }

  if (!autoFix) {
    return { nextValues: filteredLines.filter((l): l is ClaudeEntryLine => l.kind === "entry").map((l) => l.value), changes: { changes } };
  }

  const fixed = fixClaudeSession({ path: session.path, lines: filteredLines }, {
    removeApiErrorMessages: false,
    removeOrphanToolUses: false,
    removeOrphanToolResults: true,
    fixThinkingBlockOrder: true,
  });

  return { nextValues: fixed.nextValues, changes: { changes: [...changes, ...fixed.changes.changes] } };
}

export function trimClaudeSession(
  session: ClaudeSession,
  amount: CountOrPercent,
  options?: { keepLast?: boolean; preserveAssistantTurns?: boolean; autoFix?: boolean },
): OpResult {
  const keepLast = options?.keepLast ?? false;
  const preserveAssistantTurns = options?.preserveAssistantTurns ?? true;
  const autoFix = options?.autoFix ?? true;

  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const messages = entries.filter((e) => {
    const t = getEntryType(e);
    return t === "user" || t === "assistant";
  });

  let removeCount = 0;
  if (keepLast) {
    if (amount.kind !== "count") {
      throw new Error("[Claude] --keep-last requires an integer count (percent not supported).");
    }
    removeCount = Math.max(0, messages.length - amount.count);
  } else if (amount.kind === "percent") {
    removeCount = Math.floor(messages.length * (amount.percent / 100));
  } else {
    removeCount = amount.count;
  }

  if (removeCount <= 0) return { nextValues: entries.map((e) => e.value), changes: { changes: [] } };

  const initial = new Set<number>(messages.slice(0, removeCount).map((e) => e.line));
  return removeClaudeLines(session, initial, {
    preserveAssistantTurns,
    autoFix,
    initialReason: "Trimmed by request.",
    assistantTurnReason: "Trimmed to preserve full assistant turn.",
  });
}
