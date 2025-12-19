import { asString, isJsonObject } from "../../core/json.js";
import type { Issue } from "../../core/issues.js";
import type { CodexSession, CodexWrappedLine, CodexLegacyMetaLine, CodexLegacyRecordLine } from "./session.js";
import type { SuggestParams, Suggestion } from "../validate.js";

type CallKind = "function_call" | "custom_tool_call" | "local_shell_call";
type OutputKind = "function_call_output" | "custom_tool_call_output";

type CallEntry = { line: number; kind: CallKind };
type OutputEntry = { lines: number[]; kind: OutputKind };

export function validateCodexSession(session: CodexSession): Issue[] {
  const issues: Issue[] = [];

  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      issues.push({
        severity: "error",
        code: "codex.invalid_json_line",
        message: `[Codex] Invalid JSON on line ${line.line}: ${line.error}`,
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
  }

  if (session.format === "wrapped") {
    issues.push(...validateWrapped(session));
  } else {
    issues.push(...validateLegacy(session));
  }

  return issues;
}

export function suggestCodexNextSteps(session: CodexSession, params: SuggestParams): Suggestion[] {
  const out: Suggestion[] = [];
  const targetPath = session.path;

  if (session.format === "legacy") {
    out.push({
      command: `evs migrate ${JSON.stringify(targetPath)} --to codex-wrapped`,
      reason: "Legacy Codex sessions are not resumeable on modern Codex; migrate to wrapped.",
    });
  }

  if (params.issues.some((i) => i.severity === "error")) {
    out.push({
      command: `evs fix ${JSON.stringify(targetPath)}`,
      reason: "Validation reported errors; try safe auto-fixes.",
    });
  }

  const hasNoiseWarnings = params.issues.some((i) => i.code === "codex.unknown_json_line");
  if (hasNoiseWarnings) {
    out.push({
      command: `evs strip-noise ${JSON.stringify(targetPath)}`,
      reason: "Session contains lines ignored by Codex resume; consider stripping noise after backing up.",
    });
  }

  return out;
}

function validateWrapped(session: CodexSession): Issue[] {
  const issues: Issue[] = [];
  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");

  const metaLines = wrapped.filter((l) => l.type === "session_meta");
  if (metaLines.length === 0) {
    issues.push({
      severity: "error",
      code: "codex.missing_session_meta",
      message: "[Codex] Missing `session_meta` rollout item (modern `codex resume` will fail).",
      location: { kind: "file", path: session.path },
    });
  } else {
    if (metaLines.length > 1) {
      issues.push({
        severity: "info",
        code: "codex.multi_session_meta",
        message: `[Codex] Found ${metaLines.length} session_meta items (often expected for forked sessions).`,
        location: { kind: "file", path: session.path },
        details: { count: metaLines.length },
      });
    }

    const first = metaLines[0];
    if (!first) return issues;
    if (!isJsonObject(first.payload)) {
      issues.push({
        severity: "error",
        code: "codex.session_meta_payload_not_object",
        message: "[Codex] session_meta payload is not an object.",
        location: { kind: "line", path: session.path, line: first.line },
      });
    } else {
      const id = asString(first.payload.id);
      if (!id) {
        issues.push({
          severity: "error",
          code: "codex.session_meta_missing_id",
          message: "[Codex] session_meta payload is missing `id` (conversation_id).",
          location: { kind: "line", path: session.path, line: first.line },
        });
      }
    }
  }

  for (const line of session.lines) {
    if (line.kind === "unknown_json") {
      issues.push({
        severity: "warning",
        code: "codex.unknown_json_line",
        message: "[Codex] JSON line does not match RolloutLine envelope; `codex resume` will ignore it.",
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
  }

  issues.push(...validateWrappedTurnContext(session, wrapped));
  issues.push(...validateWrappedCallPairs(session, wrapped));
  issues.push(...validateCompacted(session, wrapped));

  return issues;
}

function validateWrappedTurnContext(session: CodexSession, wrapped: CodexWrappedLine[]): Issue[] {
  const issues: Issue[] = [];
  const ctxLines = wrapped.filter((l) => l.type === "turn_context");
  for (const line of ctxLines) {
    if (!isJsonObject(line.payload)) {
      issues.push({
        severity: "warning",
        code: "codex.turn_context_payload_not_object",
        message: "[Codex] turn_context payload is not an object.",
        location: { kind: "line", path: session.path, line: line.line },
      });
      continue;
    }
    const sp = line.payload.sandbox_policy;
    if (!isJsonObject(sp)) {
      issues.push({
        severity: "warning",
        code: "codex.turn_context_sandbox_policy_not_object",
        message: "[Codex] turn_context.sandbox_policy is not an object.",
        location: { kind: "line", path: session.path, line: line.line },
      });
      continue;
    }

    const mode = asString(sp.mode);
    const type = asString(sp.type);
    if (mode && type) {
      issues.push({
        severity: "warning",
        code: "codex.sandbox_policy_has_mode_and_type",
        message: "[Codex] sandbox_policy has both `mode` and `type` fields (schema drift).",
        location: { kind: "line", path: session.path, line: line.line },
      });
    } else if (!mode && !type) {
      issues.push({
        severity: "warning",
        code: "codex.sandbox_policy_missing_mode_or_type",
        message: "[Codex] sandbox_policy missing both `mode` and `type` fields (unknown schema).",
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
  }
  return issues;
}

function validateWrappedCallPairs(session: CodexSession, wrapped: CodexWrappedLine[]): Issue[] {
  const issues: Issue[] = [];
  const calls = new Map<string, CallEntry>();
  const outputs = new Map<string, OutputEntry>();

  const responseLines = wrapped.filter((l) => l.type === "response_item");
  for (const line of responseLines) {
    if (!isJsonObject(line.payload)) continue;
    const t = asString(line.payload.type);
    if (!t) continue;

    if (t === "function_call") {
      const callId = asString(line.payload.call_id);
      if (!callId) {
        issues.push({
          severity: "error",
          code: "codex.function_call_missing_call_id",
          message: "[Codex] function_call missing call_id.",
          location: { kind: "line", path: session.path, line: line.line },
        });
        continue;
      }
      if (calls.has(callId)) {
        issues.push({
          severity: "warning",
          code: "codex.duplicate_call_id",
          message: "[Codex] Duplicate call_id for function_call.",
          location: { kind: "pair", path: session.path, callId },
        });
      }
      calls.set(callId, { line: line.line, kind: "function_call" });
      continue;
    }

    if (t === "custom_tool_call") {
      const callId = asString(line.payload.call_id);
      if (!callId) {
        issues.push({
          severity: "error",
          code: "codex.custom_tool_call_missing_call_id",
          message: "[Codex] custom_tool_call missing call_id.",
          location: { kind: "line", path: session.path, line: line.line },
        });
        continue;
      }
      if (calls.has(callId)) {
        issues.push({
          severity: "warning",
          code: "codex.duplicate_call_id",
          message: "[Codex] Duplicate call_id for custom_tool_call.",
          location: { kind: "pair", path: session.path, callId },
        });
      }
      calls.set(callId, { line: line.line, kind: "custom_tool_call" });
      continue;
    }

    if (t === "local_shell_call") {
      const callId = asString(line.payload.call_id);
      if (!callId) continue;
      if (calls.has(callId)) {
        issues.push({
          severity: "warning",
          code: "codex.duplicate_call_id",
          message: "[Codex] Duplicate call_id for local_shell_call.",
          location: { kind: "pair", path: session.path, callId },
        });
      }
      calls.set(callId, { line: line.line, kind: "local_shell_call" });
      continue;
    }

    if (t === "function_call_output") {
      const callId = asString(line.payload.call_id);
      if (!callId) {
        issues.push({
          severity: "error",
          code: "codex.function_call_output_missing_call_id",
          message: "[Codex] function_call_output missing call_id.",
          location: { kind: "line", path: session.path, line: line.line },
        });
        continue;
      }
      const entry = outputs.get(callId);
      if (entry) {
        entry.lines.push(line.line);
      } else {
        outputs.set(callId, { lines: [line.line], kind: "function_call_output" });
      }
      continue;
    }

    if (t === "custom_tool_call_output") {
      const callId = asString(line.payload.call_id);
      if (!callId) {
        issues.push({
          severity: "error",
          code: "codex.custom_tool_call_output_missing_call_id",
          message: "[Codex] custom_tool_call_output missing call_id.",
          location: { kind: "line", path: session.path, line: line.line },
        });
        continue;
      }
      const entry = outputs.get(callId);
      if (entry) {
        entry.lines.push(line.line);
      } else {
        outputs.set(callId, { lines: [line.line], kind: "custom_tool_call_output" });
      }
    }
  }

  for (const [callId, out] of outputs.entries()) {
    if (out.lines.length > 1) {
      issues.push({
        severity: "warning",
        code: "codex.duplicate_outputs_for_call_id",
        message: "[Codex] Multiple outputs for the same call_id.",
        location: { kind: "pair", path: session.path, callId },
        details: { lines: out.lines.slice() },
      });
    }

    const call = calls.get(callId);
    const matches =
      call &&
      (out.kind === "function_call_output"
        ? call.kind === "function_call" || call.kind === "local_shell_call"
        : call.kind === "custom_tool_call");

    if (!matches) {
      issues.push({
        severity: "error",
        code: "codex.orphan_output",
        message: "[Codex] Tool output has no corresponding call.",
        location: { kind: "pair", path: session.path, callId },
        details: { outputLines: out.lines.slice() },
      });
    } else {
      const firstOut = Math.min(...out.lines);
      if (firstOut < call.line) {
        issues.push({
          severity: "error",
          code: "codex.output_before_call",
          message: "[Codex] Tool output appears before the corresponding call (corrupt ordering).",
          location: { kind: "pair", path: session.path, callId },
          details: { callLine: call.line, outputLine: firstOut },
        });
      }
    }
  }

  for (const [callId, call] of calls.entries()) {
    const out = outputs.get(callId);
    const matches =
      out &&
      (call.kind === "custom_tool_call"
        ? out.kind === "custom_tool_call_output"
        : out.kind === "function_call_output");
    if (!matches) {
      issues.push({
        severity: "warning",
        code: "codex.missing_output",
        message: "[Codex] Tool call has no corresponding output (maybe in-progress or truncated log).",
        location: { kind: "pair", path: session.path, callId },
        details: { callLine: call.line },
      });
    }
  }

  return issues;
}

function validateCompacted(session: CodexSession, wrapped: CodexWrappedLine[]): Issue[] {
  const issues: Issue[] = [];
  const compacted = wrapped.filter((l) => l.type === "compacted");
  for (const line of compacted) {
    if (!isJsonObject(line.payload)) {
      issues.push({
        severity: "warning",
        code: "codex.compacted_payload_not_object",
        message: "[Codex] compacted payload is not an object.",
        location: { kind: "line", path: session.path, line: line.line },
      });
      continue;
    }
    const msg = line.payload.message;
    if (typeof msg !== "string") {
      issues.push({
        severity: "warning",
        code: "codex.compacted_message_not_string",
        message: "[Codex] compacted.message is not a string.",
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
    const rh = line.payload.replacement_history;
    if (rh !== undefined && !Array.isArray(rh)) {
      issues.push({
        severity: "warning",
        code: "codex.compacted_replacement_history_not_array",
        message: "[Codex] compacted.replacement_history is not an array.",
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
  }
  return issues;
}

function validateLegacy(session: CodexSession): Issue[] {
  const issues: Issue[] = [];
  const meta = session.lines.find((l): l is CodexLegacyMetaLine => l.kind === "legacy_meta");
  if (!meta) {
    issues.push({
      severity: "error",
      code: "codex.legacy_missing_meta",
      message: "[Codex] Legacy session missing meta line with {id,timestamp}.",
      location: { kind: "file", path: session.path },
    });
  }

  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");

  const calls = new Map<string, CallEntry>();
  const outputs = new Map<string, OutputEntry>();

  for (const rec of records) {
    const rt = asString(rec.value.record_type);
    if (rt) continue;

    const t = asString(rec.value.type);
    if (!t) continue;

    if (t === "function_call") {
      const callId = asString(rec.value.call_id);
      if (!callId) continue;
      if (calls.has(callId)) {
        issues.push({
          severity: "warning",
          code: "codex.legacy_duplicate_call_id",
          message: "[Codex] Legacy has duplicate call_id for function_call.",
          location: { kind: "pair", path: session.path, callId },
        });
      }
      calls.set(callId, { line: rec.line, kind: "function_call" });
      continue;
    }

    if (t === "function_call_output") {
      const callId = asString(rec.value.call_id);
      if (!callId) continue;
      const entry = outputs.get(callId);
      if (entry) entry.lines.push(rec.line);
      else outputs.set(callId, { lines: [rec.line], kind: "function_call_output" });
      continue;
    }
  }

  for (const [callId, out] of outputs.entries()) {
    if (out.lines.length > 1) {
      issues.push({
        severity: "warning",
        code: "codex.legacy_duplicate_outputs_for_call_id",
        message: "[Codex] Legacy has multiple outputs for the same call_id.",
        location: { kind: "pair", path: session.path, callId },
        details: { lines: out.lines.slice() },
      });
    }
    if (!calls.has(callId)) {
      issues.push({
        severity: "error",
        code: "codex.legacy_orphan_output",
        message: "[Codex] Legacy tool output has no corresponding call.",
        location: { kind: "pair", path: session.path, callId },
      });
    }
  }

  for (const [callId, call] of calls.entries()) {
    if (!outputs.has(callId)) {
      issues.push({
        severity: "warning",
        code: "codex.legacy_missing_output",
        message: "[Codex] Legacy tool call has no output (maybe in-progress or truncated log).",
        location: { kind: "pair", path: session.path, callId },
        details: { callLine: call.line },
      });
    }
  }

  return issues;
}
