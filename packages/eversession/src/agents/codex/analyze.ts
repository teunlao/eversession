import { asString, isJsonObject } from "../../core/json.js";
import type { AnalyzeDetail } from "../analyze.js";
import type { CodexLegacyMetaLine, CodexLegacyRecordLine, CodexSession, CodexWrappedLine } from "./session.js";

export type CodexCallStats = {
  calls: number;
  outputs: number;
  pairedCalls: number;
  missingOutputs: number;
  orphanOutputs: number;
  duplicateOutputCallIds: number;
};

export type CodexCompactedStats = {
  total: number;
  inline: number;
  remote: number;
  unknown: number;
};

export type CodexAnalyzeReport =
  | {
      agent: "codex";
      format: "wrapped";
      conversationId?: string;
      sessionMetaCount: number;
      wrappedTypeCounts: Record<string, number>;
      invalidJsonLines: number;
      unknownJsonLines: number;
      callStats: CodexCallStats;
      compacted: CodexCompactedStats;
    }
  | {
      agent: "codex";
      format: "legacy";
      conversationId?: string;
      invalidJsonLines: number;
      unknownJsonLines: number;
      legacyStateLines: number;
      legacyRecordLines: number;
      callStats: CodexCallStats;
    };

type CallKind = "function" | "custom" | "local_shell";
type OutputKind = "function" | "custom";

function isMatching(call: CallKind | undefined, output: OutputKind): boolean {
  if (!call) return false;
  if (output === "custom") return call === "custom";
  return call === "function" || call === "local_shell";
}

function computeCallStatsWrapped(wrapped: CodexWrappedLine[]): CodexCallStats {
  const calls = new Map<string, CallKind>();
  const outputCounts = new Map<string, number>();
  const outputKinds = new Map<string, Set<OutputKind>>();

  let outputsTotal = 0;
  let orphanOutputs = 0;

  for (const line of wrapped) {
    if (line.type !== "response_item") continue;
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (!t) continue;
    const callId = asString(line.payload.call_id);
    if (!callId) continue;

    if (t === "function_call") {
      calls.set(callId, "function");
      continue;
    }
    if (t === "custom_tool_call") {
      calls.set(callId, "custom");
      continue;
    }
    if (t === "local_shell_call") {
      calls.set(callId, "local_shell");
      continue;
    }

    if (t === "function_call_output" || t === "custom_tool_call_output") {
      const kind: OutputKind = t === "custom_tool_call_output" ? "custom" : "function";
      outputsTotal += 1;
      outputCounts.set(callId, (outputCounts.get(callId) ?? 0) + 1);
      const set = outputKinds.get(callId) ?? new Set<OutputKind>();
      set.add(kind);
      outputKinds.set(callId, set);

      const callKind = calls.get(callId);
      if (!isMatching(callKind, kind)) orphanOutputs += 1;
    }
  }

  let duplicateOutputCallIds = 0;
  for (const count of outputCounts.values()) {
    if (count > 1) duplicateOutputCallIds += 1;
  }

  let missingOutputs = 0;
  let pairedCalls = 0;
  for (const [callId, callKind] of calls.entries()) {
    const kinds = outputKinds.get(callId);
    const hasMatch = kinds && (callKind === "custom" ? kinds.has("custom") : kinds.has("function"));
    if (hasMatch) pairedCalls += 1;
    else missingOutputs += 1;
  }

  return {
    calls: calls.size,
    outputs: outputsTotal,
    pairedCalls,
    missingOutputs,
    orphanOutputs,
    duplicateOutputCallIds,
  };
}

function computeCallStatsLegacy(records: CodexLegacyRecordLine[]): CodexCallStats {
  const calls = new Map<string, CallKind>();
  const outputCounts = new Map<string, number>();
  let outputsTotal = 0;
  let orphanOutputs = 0;

  for (const rec of records) {
    const rt = asString(rec.value.record_type);
    if (rt) continue;
    const t = asString(rec.value.type);
    if (!t) continue;
    const callId = asString(rec.value.call_id);
    if (!callId) continue;

    if (t === "function_call") {
      calls.set(callId, "function");
      continue;
    }

    if (t === "function_call_output") {
      outputsTotal += 1;
      outputCounts.set(callId, (outputCounts.get(callId) ?? 0) + 1);
      if (!calls.has(callId)) orphanOutputs += 1;
    }
  }

  let duplicateOutputCallIds = 0;
  for (const count of outputCounts.values()) {
    if (count > 1) duplicateOutputCallIds += 1;
  }

  let missingOutputs = 0;
  let pairedCalls = 0;
  for (const callId of calls.keys()) {
    if (outputCounts.has(callId)) pairedCalls += 1;
    else missingOutputs += 1;
  }

  return {
    calls: calls.size,
    outputs: outputsTotal,
    pairedCalls,
    missingOutputs,
    orphanOutputs,
    duplicateOutputCallIds,
  };
}

function computeCompactedStats(wrapped: CodexWrappedLine[]): CodexCompactedStats {
  let total = 0;
  let inline = 0;
  let remote = 0;
  let unknown = 0;

  for (const line of wrapped) {
    if (line.type !== "compacted") continue;
    total += 1;
    if (!isJsonObject(line.payload)) {
      unknown += 1;
      continue;
    }
    const rh = line.payload.replacement_history;
    if (Array.isArray(rh)) remote += 1;
    else if (rh === undefined) inline += 1;
    else unknown += 1;
  }

  return { total, inline, remote, unknown };
}

function extractConversationIdWrapped(wrapped: CodexWrappedLine[]): string | undefined {
  for (const line of wrapped) {
    if (line.type !== "session_meta") continue;
    if (!isJsonObject(line.payload)) continue;
    const id = asString(line.payload.id);
    if (id) return id;
  }
  return undefined;
}

function countWrappedTypes(wrapped: CodexWrappedLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of wrapped) {
    out[line.type] = (out[line.type] ?? 0) + 1;
  }
  return out;
}

function findLegacyMeta(session: CodexSession): CodexLegacyMetaLine | undefined {
  return session.lines.find((l): l is CodexLegacyMetaLine => l.kind === "legacy_meta");
}

export function analyzeCodexSession(session: CodexSession): CodexAnalyzeReport {
  const invalidJsonLines = session.lines.filter((l) => l.kind === "invalid_json").length;
  const unknownJsonLines = session.lines.filter((l) => l.kind === "unknown_json").length;

  if (session.format === "wrapped") {
    const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
    const sessionMetaCount = wrapped.filter((l) => l.type === "session_meta").length;
    const conversationId = extractConversationIdWrapped(wrapped);
    const wrappedTypeCounts = countWrappedTypes(wrapped);
    const callStats = computeCallStatsWrapped(wrapped);
    const compacted = computeCompactedStats(wrapped);

    const base: Omit<Extract<CodexAnalyzeReport, { format: "wrapped" }>, "conversationId"> = {
      agent: "codex",
      format: "wrapped",
      sessionMetaCount,
      wrappedTypeCounts,
      invalidJsonLines,
      unknownJsonLines,
      callStats,
      compacted,
    };
    return conversationId ? { ...base, conversationId } : base;
  }

  const meta = findLegacyMeta(session);
  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");
  const legacyStateLines = records.filter((r) => typeof r.value.record_type === "string").length;
  const legacyRecordLines = records.length;
  const callStats = computeCallStatsLegacy(records);
  const conversationId = meta ? meta.id : undefined;

  const base: Omit<Extract<CodexAnalyzeReport, { format: "legacy" }>, "conversationId"> = {
    agent: "codex",
    format: "legacy",
    invalidJsonLines,
    unknownJsonLines,
    legacyStateLines,
    legacyRecordLines,
    callStats,
  };
  return conversationId ? { ...base, conversationId } : base;
}

export function buildCodexAnalyzeDetail(session: CodexSession): AnalyzeDetail {
  const analysis = analyzeCodexSession(session);
  const summary: string[] = [];

  summary.push(`agent=codex format=${analysis.format}`);
  summary.push(`conversation_id=${analysis.conversationId ?? "unknown"}`);
  summary.push(`invalid_json=${analysis.invalidJsonLines} unknown_json=${analysis.unknownJsonLines}`);
  if (analysis.format === "wrapped") {
    summary.push(`session_meta=${analysis.sessionMetaCount} compacted=${analysis.compacted.total}`);
  } else {
    summary.push(`legacy_records=${analysis.legacyRecordLines} legacy_state=${analysis.legacyStateLines}`);
  }
  summary.push(
    `tools: calls=${analysis.callStats.calls} outputs=${analysis.callStats.outputs} orphan_outputs=${analysis.callStats.orphanOutputs} missing_outputs=${analysis.callStats.missingOutputs}`,
  );

  return { format: analysis.format, analysis, summary };
}
