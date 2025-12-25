import type { Change, ChangeSet } from "../../core/changes.js";
import { asString, isJsonObject } from "../../core/json.js";
import type { CodexLegacyRecordLine, CodexSession, CodexWrappedLine } from "./session.js";

export type FixOptions = {
  removeOrphanOutputs?: boolean;
  normalizeSandboxPolicy?: boolean;
  dedupeLegacyOutputs?: boolean;
  insertAbortedOutputs?: boolean;
};

export type FixResult = {
  nextValues: unknown[];
  changes: ChangeSet;
};

export function fixCodexSession(session: CodexSession, options: FixOptions): FixResult {
  const changes: Change[] = [];

  const removeOrphanOutputs = options.removeOrphanOutputs ?? true;
  const normalizeSandboxPolicy = options.normalizeSandboxPolicy ?? true;
  const dedupeLegacyOutputs = options.dedupeLegacyOutputs ?? true;
  const insertAbortedOutputs = options.insertAbortedOutputs ?? false;

  const dropLines = new Set<number>();
  const insertAfter = new Map<number, Record<string, unknown>[]>();

  if (removeOrphanOutputs && session.format === "wrapped") {
    const { orphanOutputLines } = findOrphanOutputsWrapped(session);
    for (const line of orphanOutputLines) {
      dropLines.add(line);
      changes.push({
        kind: "delete_line",
        line,
        reason: "Removed orphan tool output (no matching call_id).",
      });
    }
  }

  if (normalizeSandboxPolicy && session.format === "wrapped") {
    for (const line of session.lines) {
      if (line.kind !== "wrapped") continue;
      if (line.type !== "turn_context") continue;
      if (!isJsonObject(line.payload)) continue;
      const sp = line.payload.sandbox_policy;
      if (!isJsonObject(sp)) continue;
      const mode = asString(sp.mode);
      const type = asString(sp.type);
      if (mode && !type) {
        sp.type = mode;
        delete sp.mode;
        changes.push({
          kind: "update_line",
          line: line.line,
          reason: "Normalized sandbox_policy: `mode` -> `type`.",
        });
      }
    }
  }

  if (dedupeLegacyOutputs && session.format === "legacy") {
    const duplicates = findDuplicateLegacyOutputs(session);
    for (const line of duplicates.linesToDrop) {
      dropLines.add(line);
      changes.push({
        kind: "delete_line",
        line,
        reason: "Removed duplicate legacy function_call_output (kept last per call_id).",
      });
    }
  }

  if (insertAbortedOutputs && session.format === "wrapped") {
    const inserts = buildAbortedOutputsWrapped(session, dropLines);
    for (const ins of inserts) {
      const arr = insertAfter.get(ins.afterLine) ?? [];
      arr.push(ins.value);
      insertAfter.set(ins.afterLine, arr);
      changes.push({
        kind: "insert_after",
        afterLine: ins.afterLine,
        reason: `Inserted synthetic aborted output for missing call_id=${ins.callId}.`,
      });
    }
  }

  const nextValues: unknown[] = [];
  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      dropLines.add(line.line);
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: "Dropped invalid JSON line (cannot be preserved in JSONL rewrite).",
      });
      continue;
    }
    if (dropLines.has(line.line)) continue;
    nextValues.push(line.value);
    const inserts = insertAfter.get(line.line);
    if (inserts) nextValues.push(...inserts);
  }

  return { nextValues, changes: { changes } };
}

function findOrphanOutputsWrapped(session: CodexSession): { orphanOutputLines: number[] } {
  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");

  const calls = new Map<string, "function" | "custom" | "local_shell">();
  const outputs = new Map<string, { kind: "function" | "custom"; line: number }[]>();

  for (const line of wrapped) {
    if (line.type !== "response_item") continue;
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (!t) continue;

    if (t === "function_call") {
      const callId = asString(line.payload.call_id);
      if (callId) calls.set(callId, "function");
      continue;
    }
    if (t === "custom_tool_call") {
      const callId = asString(line.payload.call_id);
      if (callId) calls.set(callId, "custom");
      continue;
    }
    if (t === "local_shell_call") {
      const callId = asString(line.payload.call_id);
      if (callId) calls.set(callId, "local_shell");
      continue;
    }

    if (t === "function_call_output") {
      const callId = asString(line.payload.call_id);
      if (!callId) continue;
      const arr = outputs.get(callId) ?? [];
      arr.push({ kind: "function", line: line.line });
      outputs.set(callId, arr);
      continue;
    }
    if (t === "custom_tool_call_output") {
      const callId = asString(line.payload.call_id);
      if (!callId) continue;
      const arr = outputs.get(callId) ?? [];
      arr.push({ kind: "custom", line: line.line });
      outputs.set(callId, arr);
    }
  }

  const orphanLines: number[] = [];
  for (const [callId, outLines] of outputs.entries()) {
    const callKind = calls.get(callId);
    for (const out of outLines) {
      const matches =
        callKind &&
        (out.kind === "function" ? callKind === "function" || callKind === "local_shell" : callKind === "custom");
      if (!matches) orphanLines.push(out.line);
    }
  }
  orphanLines.sort((a, b) => a - b);
  return { orphanOutputLines: orphanLines };
}

function findDuplicateLegacyOutputs(session: CodexSession): { linesToDrop: number[] } {
  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");
  const outputsByCallId = new Map<string, number[]>();

  for (const rec of records) {
    const rt = asString(rec.value.record_type);
    if (rt) continue;
    const t = asString(rec.value.type);
    if (t !== "function_call_output") continue;
    const callId = asString(rec.value.call_id);
    if (!callId) continue;
    const arr = outputsByCallId.get(callId) ?? [];
    arr.push(rec.line);
    outputsByCallId.set(callId, arr);
  }

  const linesToDrop: number[] = [];
  for (const lines of outputsByCallId.values()) {
    if (lines.length <= 1) continue;
    const sorted = [...lines].sort((a, b) => a - b);
    sorted.pop();
    linesToDrop.push(...sorted);
  }
  linesToDrop.sort((a, b) => a - b);
  return { linesToDrop };
}

function buildAbortedOutputsWrapped(
  session: CodexSession,
  dropLines: Set<number>,
): { afterLine: number; callId: string; value: Record<string, unknown> }[] {
  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");

  const calls = new Map<string, { line: number; kind: "function" | "custom"; timestamp: string }>();
  const outputs = new Set<string>();

  for (const line of wrapped) {
    if (dropLines.has(line.line)) continue;
    if (line.type !== "response_item") continue;
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (!t) continue;
    const callId = asString(line.payload.call_id);
    if (!callId) continue;

    if (t === "function_call" || t === "local_shell_call") {
      calls.set(callId, { line: line.line, kind: "function", timestamp: line.timestamp });
      continue;
    }
    if (t === "custom_tool_call") {
      calls.set(callId, { line: line.line, kind: "custom", timestamp: line.timestamp });
      continue;
    }
    if (t === "function_call_output" || t === "custom_tool_call_output") {
      outputs.add(callId);
    }
  }

  const inserts: { afterLine: number; callId: string; value: Record<string, unknown> }[] = [];
  for (const [callId, call] of calls.entries()) {
    if (outputs.has(callId)) continue;
    const payload =
      call.kind === "custom"
        ? { type: "custom_tool_call_output", call_id: callId, output: "aborted" }
        : { type: "function_call_output", call_id: callId, output: "aborted" };
    inserts.push({
      afterLine: call.line,
      callId,
      value: { timestamp: call.timestamp, type: "response_item", payload },
    });
  }

  inserts.sort((a, b) => a.afterLine - b.afterLine);
  return inserts;
}
