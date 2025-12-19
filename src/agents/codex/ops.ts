import { asString, isJsonObject } from "../../core/json.js";
import type { Change, ChangeSet } from "../../core/changes.js";
import type { CountOrPercent } from "../../core/spec.js";
import type { CodexSession, CodexWrappedLine, CodexLegacyRecordLine } from "./session.js";

export type OpResult = { nextValues: unknown[]; changes: ChangeSet };

type CallKind = "function" | "custom" | "local_shell";
type OutputKind = "function" | "custom";

type CallEntry = { line: number; kind: CallKind };
type OutputEntry = { lines: Set<number>; kind: OutputKind };

function collectCallMaps(session: CodexSession): {
  calls: Map<string, CallEntry>;
  outputs: Map<string, OutputEntry>;
} {
  const calls = new Map<string, CallEntry>();
  const outputs = new Map<string, OutputEntry>();

  const addOutput = (callId: string, line: number, kind: OutputKind): void => {
    const existing = outputs.get(callId);
    if (existing) existing.lines.add(line);
    else outputs.set(callId, { lines: new Set([line]), kind });
  };

  if (session.format === "wrapped") {
    const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
    for (const line of wrapped) {
      if (line.type !== "response_item") continue;
      if (!isJsonObject(line.payload)) continue;
      const t = asString(line.payload.type);
      if (!t) continue;
      const callId = asString(line.payload.call_id);
      if (!callId) continue;

      if (t === "function_call") {
        calls.set(callId, { line: line.line, kind: "function" });
      } else if (t === "custom_tool_call") {
        calls.set(callId, { line: line.line, kind: "custom" });
      } else if (t === "local_shell_call") {
        calls.set(callId, { line: line.line, kind: "local_shell" });
      } else if (t === "function_call_output") {
        addOutput(callId, line.line, "function");
      } else if (t === "custom_tool_call_output") {
        addOutput(callId, line.line, "custom");
      }
    }
    return { calls, outputs };
  }

  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");
  for (const rec of records) {
    const rt = asString(rec.value.record_type);
    if (rt) continue;
    const t = asString(rec.value.type);
    if (!t) continue;
    const callId = asString(rec.value.call_id);
    if (!callId) continue;

    if (t === "function_call") calls.set(callId, { line: rec.line, kind: "function" });
    else if (t === "function_call_output") addOutput(callId, rec.line, "function");
  }

  return { calls, outputs };
}

function isMatchingPair(call: CallEntry | undefined, out: OutputEntry): boolean {
  if (!call) return false;
  if (out.kind === "custom") return call.kind === "custom";
  return call.kind === "function" || call.kind === "local_shell";
}

export function removeCodexLines(
  session: CodexSession,
  initialLines: Set<number>,
  options?: { preserveCallPairs?: boolean },
): OpResult {
  const preserveCallPairs = options?.preserveCallPairs ?? true;

  const changes: Change[] = [];
  const reasons = new Map<number, string>();
  for (const line of initialLines) reasons.set(line, "Removed by request.");

  const toRemove = new Set<number>(initialLines);

  if (preserveCallPairs) {
    const { calls, outputs } = collectCallMaps(session);

    for (const [callId, call] of calls.entries()) {
      if (!toRemove.has(call.line)) continue;
      const out = outputs.get(callId);
      if (!out) continue;
      for (const line of out.lines) {
        if (toRemove.has(line)) continue;
        toRemove.add(line);
        reasons.set(line, "Removed to preserve call/output pairing.");
      }
    }

    for (const [callId, out] of outputs.entries()) {
      const call = calls.get(callId);
      const callRemoved = call ? toRemove.has(call.line) : true;
      if (callRemoved || !isMatchingPair(call, out)) {
        for (const line of out.lines) {
          if (toRemove.has(line)) continue;
          toRemove.add(line);
          reasons.set(line, "Removed orphan tool output (no matching call).");
        }
      }
    }
  }

  const nextValues: unknown[] = [];
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
      changes.push({ kind: "delete_line", line: line.line, reason: reasons.get(line.line) ?? "Removed line." });
      continue;
    }
    if ("value" in line) nextValues.push(line.value);
  }

  return { nextValues, changes: { changes } };
}

function collectHistoryLines(session: CodexSession): number[] {
  if (session.format === "wrapped") {
    const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
    const lastCompactedLine = wrapped.reduce((max, line) => (line.type === "compacted" ? Math.max(max, line.line) : max), 0);
    return wrapped.filter((l) => l.type === "response_item" && l.line > lastCompactedLine).map((l) => l.line);
  }
  return session.lines
    .filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record" && asString(l.value.record_type) === undefined)
    .map((l) => l.line);
}

export function trimCodexSession(
  session: CodexSession,
  amount: CountOrPercent,
  options?: { keepLast?: boolean },
): OpResult {
  const keepLast = options?.keepLast ?? false;
  const historyLines = collectHistoryLines(session);

  let removeCount = 0;
  if (keepLast) {
    if (amount.kind !== "count") {
      throw new Error("[Codex] --keep-last requires an integer count (percent not supported).");
    }
    removeCount = Math.max(0, historyLines.length - amount.count);
  } else if (amount.kind === "percent") {
    removeCount = Math.floor(historyLines.length * (amount.percent / 100));
  } else {
    removeCount = amount.count;
  }

  if (removeCount <= 0) {
    const nextValues = session.lines.flatMap((l) => ("value" in l ? [l.value] : []));
    return { nextValues, changes: { changes: [] } };
  }

  const initial = new Set<number>(historyLines.slice(0, removeCount));
  return removeCodexLines(session, initial, { preserveCallPairs: true });
}

export function stripNoiseCodexSession(
  session: CodexSession,
  options?: { dropTurnContext?: boolean; dropEventMsg?: boolean; dropLegacyState?: boolean },
): OpResult {
  const dropTurnContext = options?.dropTurnContext ?? true;
  const dropEventMsg = options?.dropEventMsg ?? true;
  const dropLegacyState = options?.dropLegacyState ?? true;

  const changes: Change[] = [];
  const nextValues: unknown[] = [];

  const shouldDropWrapped = (type: string): string | undefined => {
    if (dropTurnContext && type === "turn_context") return "Dropped turn_context (noise; does not affect resume history).";
    if (dropEventMsg && type === "event_msg") return "Dropped event_msg (noise; does not affect resume history).";
    return undefined;
  };

  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: "Dropped invalid JSON line (cannot be preserved in JSONL rewrite).",
      });
      continue;
    }

    if (session.format === "wrapped" && line.kind === "wrapped") {
      const reason = shouldDropWrapped(line.type);
      if (reason) {
        changes.push({ kind: "delete_line", line: line.line, reason });
        continue;
      }
    }

    if (session.format === "legacy" && dropLegacyState && line.kind === "legacy_record") {
      const rt = asString(line.value.record_type);
      if (rt) {
        changes.push({
          kind: "delete_line",
          line: line.line,
          reason: "Dropped legacy record_type line (state/noise).",
        });
        continue;
      }
    }

    nextValues.push(line.value);
  }

  return { nextValues, changes: { changes } };
}
