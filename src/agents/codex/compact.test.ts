import { describe, expect, it } from "vitest";

import { parseCodexSessionFromValues } from "./session.js";
import { validateCodexSession } from "./validate.js";
import { compactCodexSession } from "./compact.js";

describe("codex compact", () => {
  it("inserts a compacted checkpoint and preserves pinned initial context via replacement_history", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      {
        timestamp: ts,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" }],
        },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>...</INSTRUCTIONS>" }],
        },
      },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a2" }] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = compactCodexSession(parsed.session!, { kind: "count", count: 2 }, "SUMMARY");

    const compactedIdx = op.nextValues.findIndex(
      (v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "compacted",
    );
    expect(compactedIdx).toBeGreaterThan(-1);

    const q2Idx = op.nextValues.findIndex((v) => JSON.stringify(v).includes("\"q2\""));
    expect(q2Idx).toBeGreaterThan(-1);
    expect(compactedIdx).toBeLessThan(q2Idx);

    const compacted = op.nextValues[compactedIdx] as Record<string, unknown>;
    const payload = compacted.payload as unknown;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    const rh = (payload as Record<string, unknown>).replacement_history as unknown;
    expect(Array.isArray(rh)).toBe(true);
    expect((rh as unknown[]).length).toBe(3); // 2 pinned + 1 summary message

    const responseItemStrings = op.nextValues
      .filter((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "response_item")
      .map((v) => JSON.stringify(v))
      .join("\n");
    expect(responseItemStrings.includes("environment_context")).toBe(false);
    expect(responseItemStrings.includes("AGENTS.md")).toBe(false);
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"q1\""))).toBe(false);
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"a1\""))).toBe(false);
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"q2\""))).toBe(true);
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"a2\""))).toBe(true);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("removes outputs for calls that are compacted away", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{}", call_id: "c1" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "out" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = compactCodexSession(parsed.session!, { kind: "count", count: 1 }, "SUMMARY");
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"function_call_output\""))).toBe(false);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.code === "codex.orphan_output" && i.severity === "error")).toBe(false);
  });

  it("drops prior compacted items before the new checkpoint", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } },
      { timestamp: ts, type: "compacted", payload: { message: "oldsum" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = compactCodexSession(parsed.session!, { kind: "count", count: 1 }, "SUMMARY");
    expect(op.nextValues.some((v) => JSON.stringify(v).includes("\"oldsum\""))).toBe(false);
    const compactedCount = op.nextValues.filter(
      (v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "compacted",
    ).length;
    expect(compactedCount).toBe(1);
  });

  it("can compact away all response_items and append a checkpoint at the end", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = compactCodexSession(parsed.session!, { kind: "count", count: 1 }, "SUMMARY");
    expect(op.nextValues.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "response_item")).toBe(false);
    expect(op.nextValues.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "compacted")).toBe(true);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });
});
