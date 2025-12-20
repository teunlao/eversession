import type { Change, ChangeSet } from "../../core/changes.js";
import { asString, isJsonObject } from "../../core/json.js";
import { type CountOrPercent, parseCountOrPercent } from "../../core/spec.js";
import type { CompactPrepareParams, CompactPrepareResult } from "../compact.js";
import type { CodexSession, CodexWrappedLine } from "./session.js";

export type CompactResult = { nextValues: unknown[]; changes: ChangeSet };

export function prepareCodexCompact(session: CodexSession, params: CompactPrepareParams): CompactPrepareResult {
  if (params.amountTokensRaw) {
    return {
      ok: false,
      exitCode: 2,
      issues: [
        {
          severity: "error",
          code: "core.compact_tokens_unsupported",
          message: "[Core] --amount-tokens is only supported for Claude sessions.",
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  if (!params.summary || params.summary.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      issues: [
        {
          severity: "error",
          code: "core.codex_llm_not_supported",
          message: "[Core] Codex LLM summary not yet supported. Use --summary <text>.",
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  if (session.format !== "wrapped") {
    return {
      ok: false,
      exitCode: 2,
      issues: [
        {
          severity: "error",
          code: "core.codex_compact_requires_wrapped",
          message: "[Core] Codex `compact` requires wrapped rollout sessions. Run `migrate --to codex-wrapped` first.",
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  const amount = parseCountOrPercent(params.amountMessagesRaw ?? params.amountRaw);

  return {
    ok: true,
    plan: {
      amount,
      summary: params.summary,
      options: { keepLast: params.keepLast ?? false },
    },
  };
}

type CallKind = "function" | "custom" | "local_shell";
type OutputKind = "function" | "custom";

type CallEntry = { line: number; kind: CallKind };
type OutputEntry = { lines: Set<number>; kind: OutputKind };

function isMatchingPair(call: CallEntry | undefined, out: OutputEntry): boolean {
  if (!call) return false;
  if (out.kind === "custom") return call.kind === "custom";
  return call.kind === "function" || call.kind === "local_shell";
}

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

  if (session.format !== "wrapped") return { calls, outputs };

  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
  for (const line of wrapped) {
    if (line.type !== "response_item") continue;
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (!t) continue;
    const callId = asString(line.payload.call_id);
    if (!callId) continue;

    if (t === "function_call") calls.set(callId, { line: line.line, kind: "function" });
    else if (t === "custom_tool_call") calls.set(callId, { line: line.line, kind: "custom" });
    else if (t === "local_shell_call") calls.set(callId, { line: line.line, kind: "local_shell" });
    else if (t === "function_call_output") addOutput(callId, line.line, "function");
    else if (t === "custom_tool_call_output") addOutput(callId, line.line, "custom");
  }

  return { calls, outputs };
}

function getMessageText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!Array.isArray(content)) return undefined;
  let out = "";
  for (const part of content) {
    if (!isJsonObject(part)) continue;
    const t = asString(part.type);
    if (t !== "input_text" && t !== "output_text") continue;
    const text = asString(part.text);
    if (!text) continue;
    out += text;
  }
  return out.length > 0 ? out : undefined;
}

function looksLikeInitialContext(text: string): boolean {
  if (text.includes("<environment_context>")) return true;
  if (text.includes("AGENTS.md")) return true;
  if (text.includes("<INSTRUCTIONS>")) return true;
  if (text.includes("Codex CLI")) return true;
  return false;
}

function findPinnedInitialContext(wrapped: CodexWrappedLine[]): {
  lines: number[];
  payloads: Record<string, unknown>[];
} {
  const lines: number[] = [];
  const payloads: Record<string, unknown>[] = [];

  for (const line of wrapped) {
    if (line.type !== "response_item") continue;
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (t !== "message") continue;
    const role = asString(line.payload.role);
    if (!role) continue;
    if (role === "assistant") break;
    if (role === "developer" || role === "system") {
      lines.push(line.line);
      payloads.push(line.payload);
      continue;
    }
    if (role === "user") {
      const text = getMessageText(line.payload);
      if (!text) continue;
      if (!looksLikeInitialContext(text)) continue;
      lines.push(line.line);
      payloads.push(line.payload);
    }
  }

  return { lines, payloads };
}

function buildSummaryMessagePayload(summary: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: summary }],
  };
}

export function compactCodexSession(
  session: CodexSession,
  amount: CountOrPercent,
  summary: string,
  options?: { keepLast?: boolean },
): CompactResult {
  if (session.format !== "wrapped") {
    throw new Error("[Codex] `compact` requires wrapped rollout sessions. Run `migrate --to codex-wrapped` first.");
  }
  const keepLast = options?.keepLast ?? false;

  const changes: Change[] = [];

  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
  const responseItems = wrapped.filter((l) => l.type === "response_item" && isJsonObject(l.payload));
  const pinned = findPinnedInitialContext(responseItems);
  const pinnedSet = new Set<number>(pinned.lines);
  const candidates = responseItems.filter((l) => !pinnedSet.has(l.line));

  let removeCount = 0;
  if (keepLast) {
    if (amount.kind !== "count")
      throw new Error("[Codex] --keep-last requires an integer count (percent not supported).");
    removeCount = Math.max(0, candidates.length - amount.count);
  } else if (amount.kind === "percent") {
    removeCount = Math.floor(candidates.length * (amount.percent / 100));
  } else {
    removeCount = amount.count;
  }

  if (removeCount <= 0) {
    const nextValues = session.lines.flatMap((l) => ("value" in l ? [l.value] : []));
    return { nextValues, changes: { changes: [] } };
  }

  const reasons = new Map<number, string>();
  const toRemove = new Set<number>();

  for (const line of pinned.lines) {
    toRemove.add(line);
    reasons.set(line, "Moved into compaction replacement_history.");
  }

  for (const line of candidates.slice(0, removeCount)) {
    toRemove.add(line.line);
    reasons.set(line.line, "Compacted into summary.");
  }

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

  const firstKeptResponse = responseItems.find((l) => !toRemove.has(l.line));
  const insertionLine = firstKeptResponse?.line ?? Number.POSITIVE_INFINITY;

  for (const line of wrapped) {
    if (line.type !== "compacted") continue;
    if (line.line < insertionLine) {
      toRemove.add(line.line);
      reasons.set(line.line, "Dropped prior compacted checkpoint (superseded).");
    }
  }

  const replacementHistory: Record<string, unknown>[] = [...pinned.payloads, buildSummaryMessagePayload(summary)];
  const compactedValue = {
    timestamp: new Date().toISOString(),
    type: "compacted",
    payload: {
      message: summary,
      replacement_history: replacementHistory,
    },
  };

  const nextValues: unknown[] = [];
  let inserted = false;
  let insertionAfterLine = 0;
  let lastKeptLine = 0;

  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: "Dropped invalid JSON line (cannot be preserved in JSONL rewrite).",
      });
      continue;
    }

    if (!inserted && firstKeptResponse && line.line === firstKeptResponse.line) {
      insertionAfterLine = lastKeptLine;
      changes.push({
        kind: "insert_after",
        afterLine: insertionAfterLine,
        reason: "Inserted Codex compaction checkpoint (replacement_history).",
      });
      nextValues.push(compactedValue);
      inserted = true;
    }

    if (toRemove.has(line.line)) {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: reasons.get(line.line) ?? "Compacted/removed.",
      });
      continue;
    }

    nextValues.push(line.value);
    lastKeptLine = line.line;
  }

  if (!inserted) {
    insertionAfterLine = lastKeptLine;
    changes.push({
      kind: "insert_after",
      afterLine: insertionAfterLine,
      reason: "Inserted Codex compaction checkpoint (replacement_history).",
    });
    nextValues.push(compactedValue);
  }

  return { nextValues, changes: { changes } };
}
