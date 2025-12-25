import { describe, expect, it } from "vitest";
import { analyzeCodexSession } from "./analyze.js";
import { parseCodexSessionFromValues } from "./session.js";

describe("codex/analyze", () => {
  it("analyzes wrapped sessions (calls, outputs, compacted)", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "event_msg", payload: { type: "user_message" } },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: "x" },
      },
      { timestamp: ts, type: "compacted", payload: { message: "ok" } },
      { timestamp: ts, type: "compacted", payload: { message: "ok", replacement_history: [] } },
    ]);
    if (!parsed.session) throw new Error("parse failed");

    const report = analyzeCodexSession(parsed.session);
    expect(report.format).toBe("wrapped");
    expect(report.conversationId).toBe("conv_1");
    expect(report.sessionMetaCount).toBe(1);
    expect(report.wrappedTypeCounts.session_meta).toBe(1);
    expect(report.wrappedTypeCounts.response_item).toBe(2);
    expect(report.wrappedTypeCounts.event_msg).toBe(1);

    expect(report.callStats.calls).toBe(1);
    expect(report.callStats.outputs).toBe(1);
    expect(report.callStats.pairedCalls).toBe(1);
    expect(report.callStats.missingOutputs).toBe(0);
    expect(report.callStats.orphanOutputs).toBe(0);

    expect(report.compacted.total).toBe(2);
    expect(report.compacted.inline).toBe(1);
    expect(report.compacted.remote).toBe(1);
  });

  it("counts orphan outputs when kind mismatches", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call_1", output: "x" },
      },
    ]);
    if (!parsed.session) throw new Error("parse failed");

    const report = analyzeCodexSession(parsed.session);
    expect(report.format).toBe("wrapped");
    expect(report.callStats.outputs).toBe(1);
    expect(report.callStats.orphanOutputs).toBe(1);
    expect(report.callStats.pairedCalls).toBe(0);
    expect(report.callStats.missingOutputs).toBe(1);
  });

  it("analyzes legacy sessions (state lines + calls)", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { id: "conv_legacy", timestamp: ts, instructions: null },
      { record_type: "state", note: "noise" },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "x" },
    ]);
    if (!parsed.session) throw new Error("parse failed");

    const report = analyzeCodexSession(parsed.session);
    expect(report.format).toBe("legacy");
    expect(report.conversationId).toBe("conv_legacy");
    expect(report.legacyRecordLines).toBe(3);
    expect(report.legacyStateLines).toBe(1);
    expect(report.callStats.calls).toBe(1);
    expect(report.callStats.outputs).toBe(1);
  });
});
