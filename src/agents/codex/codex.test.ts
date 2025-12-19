import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCodexSession, parseCodexSessionFromValues } from "./session.js";
import { validateCodexSession } from "./validate.js";
import { fixCodexSession } from "./fix.js";
import { migrateLegacyCodexToWrapped } from "./migrate.js";
import { stripNoiseCodexSession, trimCodexSession } from "./ops.js";
import { stringifyJsonl } from "../../core/jsonl.js";

async function writeTempJsonl(values: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, stringifyJsonl(values), "utf8");
  return path;
}

async function writeTempRaw(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

describe("codex", () => {
  it("validates wrapped sessions with session_meta", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempJsonl([
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [] } },
    ]);

    const parsed = await parseCodexSession(path);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = [...parsed.issues, ...(parsed.session ? validateCodexSession(parsed.session) : [])];
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("errors when wrapped session is missing session_meta", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempJsonl([{ timestamp: ts, type: "response_item", payload: { type: "message" } }]);

    const parsed = await parseCodexSession(path);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.missing_session_meta" && i.severity === "error")).toBe(true);
  });

  it("parses wrapped sessions even with invalid JSON lines", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempRaw(
      [
        "{not json",
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } }),
        JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [] } }),
        "",
      ].join("\n"),
    );

    const parsed = await parseCodexSession(path);
    expect(parsed.session?.format).toBe("wrapped");
    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.invalid_json_line" && i.severity === "error")).toBe(true);
    expect(issues.some((i) => i.code === "codex.missing_session_meta" && i.severity === "error")).toBe(false);
  });

  it("fix removes orphan outputs in wrapped sessions", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempJsonl([
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: "oops" },
      },
    ]);

    const parsed = await parseCodexSession(path);
    const preIssues = validateCodexSession(parsed.session!);
    expect(preIssues.some((i) => i.code === "codex.orphan_output" && i.severity === "error")).toBe(true);

    const fixed = fixCodexSession(parsed.session!, {});
    expect(fixed.nextValues.length).toBe(1);
    expect(fixed.changes.changes.some((c) => c.kind === "delete_line")).toBe(true);

    const nextPath = await writeTempJsonl(fixed.nextValues);
    const parsed2 = await parseCodexSession(nextPath);
    const postIssues = validateCodexSession(parsed2.session!);
    expect(postIssues.some((i) => i.severity === "error")).toBe(false);
  });

  it("fix normalizes sandbox_policy mode -> type", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempJsonl([
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "turn_context", payload: { sandbox_policy: { mode: "danger" } } },
    ]);

    const parsed = await parseCodexSession(path);
    const fixed = fixCodexSession(parsed.session!, {});

    const turn = fixed.nextValues.find((v): v is Record<string, unknown> => {
      if (typeof v !== "object" || v === null) return false;
      if (!("type" in v)) return false;
      return (v as Record<string, unknown>).type === "turn_context";
    });
    expect(turn).toBeTruthy();
    const payload = (turn as Record<string, unknown>).payload;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    const sandboxPolicy = (payload as Record<string, unknown>).sandbox_policy as unknown;
    expect(typeof sandboxPolicy).toBe("object");
    expect(sandboxPolicy).not.toBeNull();
    const sp = sandboxPolicy as Record<string, unknown>;
    expect(sp.type).toBe("danger");
    expect(sp.mode).toBeUndefined();
  });

  it("migrates legacy sessions to wrapped with best-effort cwd", async () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const path = await writeTempJsonl([
      { id: "conv_legacy", timestamp: ts, instructions: null, git: { branch: "main" } },
      { record_type: "state", note: "noise" },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context><cwd>/Users/teunlao/projects/shinra</cwd></environment_context>",
          },
        ],
      },
      { type: "message", role: "assistant", content: [] },
    ]);

    const parsed = await parseCodexSession(path);
    expect(parsed.session?.format).toBe("legacy");

    const migrated = migrateLegacyCodexToWrapped(parsed.session!);
    const migratedPath = await writeTempJsonl(migrated.nextValues);

    const parsed2 = await parseCodexSession(migratedPath);
    expect(parsed2.session?.format).toBe("wrapped");

    const metaLine = parsed2.session!.lines.find((l) => l.kind === "wrapped" && l.type === "session_meta");
    expect(metaLine).toBeTruthy();
    expect(metaLine).toBeTruthy();
    const payload = (metaLine as unknown as { payload: unknown }).payload;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).cwd).toBe("/Users/teunlao/projects/shinra");

    const postIssues = validateCodexSession(parsed2.session!);
    expect(postIssues.some((i) => i.severity === "error")).toBe(false);
  });

  it("trim removes tool outputs that would become orphaned", () => {
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
        payload: { type: "function_call_output", call_id: "call_1", output: "file contents" },
      },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = trimCodexSession(parsed.session!, { kind: "count", count: 1 });
    const hasOutput = op.nextValues.some((v) => {
      if (typeof v !== "object" || v === null) return false;
      const obj = v as Record<string, unknown>;
      if (obj.type !== "response_item") return false;
      const payload = obj.payload;
      if (typeof payload !== "object" || payload === null) return false;
      return (payload as Record<string, unknown>).type === "function_call_output";
    });
    expect(hasOutput).toBe(false);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("trim operates on history after the last compacted item", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
      { timestamp: ts, type: "compacted", payload: { message: "summary" } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = trimCodexSession(parsed.session!, { kind: "count", count: 1 });

    const hasOld = op.nextValues.some((v) => {
      if (typeof v !== "object" || v === null) return false;
      const obj = v as Record<string, unknown>;
      if (obj.type !== "response_item") return false;
      const payload = obj.payload;
      if (typeof payload !== "object" || payload === null) return false;
      return JSON.stringify(payload).includes("\"old\"");
    });
    expect(hasOld).toBe(true);

    const hasNew = op.nextValues.some((v) => {
      if (typeof v !== "object" || v === null) return false;
      const obj = v as Record<string, unknown>;
      if (obj.type !== "response_item") return false;
      const payload = obj.payload;
      if (typeof payload !== "object" || payload === null) return false;
      return JSON.stringify(payload).includes("\"new\"");
    });
    expect(hasNew).toBe(false);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("strip-noise drops turn_context and event_msg in wrapped sessions", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "event_msg", payload: { type: "user_message", text: "hi" } },
      { timestamp: ts, type: "turn_context", payload: { sandbox_policy: { type: "danger" } } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const op = stripNoiseCodexSession(parsed.session!, {});
    expect(op.nextValues.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "event_msg")).toBe(false);
    expect(op.nextValues.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).type === "turn_context")).toBe(false);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("strip-noise drops legacy record_type state lines", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { id: "conv_legacy", timestamp: ts, instructions: null },
      { record_type: "state", note: "noise" },
      { type: "message", role: "user", content: [] },
    ]);
    expect(parsed.session?.format).toBe("legacy");

    const op = stripNoiseCodexSession(parsed.session!, {});
    expect(op.nextValues.some((v) => typeof v === "object" && v !== null && "record_type" in (v as Record<string, unknown>))).toBe(false);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", op.nextValues);
    const issues = validateCodexSession(postParsed.session!);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("can insert synthetic aborted outputs for missing tool calls (unsafe)", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{}", call_id: "c1" } },
      { timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "{}", call_id: "c2" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const preIssues = validateCodexSession(parsed.session!);
    expect(preIssues.some((i) => i.code === "codex.missing_output" && i.severity === "warning")).toBe(true);

    const fixed = fixCodexSession(parsed.session!, { insertAbortedOutputs: true });
    expect(
      fixed.nextValues.some((v) => JSON.stringify(v).includes("\"function_call_output\"") && JSON.stringify(v).includes("\"c1\"")),
    ).toBe(true);
    expect(
      fixed.nextValues.some((v) => JSON.stringify(v).includes("\"custom_tool_call_output\"") && JSON.stringify(v).includes("\"c2\"")),
    ).toBe(true);

    const postParsed = parseCodexSessionFromValues("memory.jsonl", fixed.nextValues);
    const postIssues = validateCodexSession(postParsed.session!);
    expect(postIssues.some((i) => i.code === "codex.missing_output")).toBe(false);
    expect(postIssues.some((i) => i.severity === "error")).toBe(false);
  });

  it("detects output_before_call when output precedes the call", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "x" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "c1", name: "Read", arguments: "{}" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.output_before_call" && i.severity === "error")).toBe(true);
  });

  it("flags mismatched tool call/output kinds", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "{}" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "wrong kind" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.orphan_output" && i.severity === "error")).toBe(true);
    expect(issues.some((i) => i.code === "codex.missing_output" && i.severity === "warning")).toBe(true);
  });

  it("warns when a call has multiple outputs for the same call_id", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "c1", name: "Read", arguments: "{}" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "1" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "2" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.duplicate_outputs_for_call_id" && i.severity === "warning")).toBe(true);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("warns on duplicate call_id for tool calls", () => {
    const ts = "2025-12-16T00:00:00.000Z";
    const parsed = parseCodexSessionFromValues("memory.jsonl", [
      { timestamp: ts, type: "session_meta", payload: { id: "conv_1", timestamp: ts, cwd: "/tmp" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "c1", name: "Read", arguments: "{}" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "c1", name: "Read", arguments: "{}" } },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
    ]);
    expect(parsed.session?.format).toBe("wrapped");

    const issues = validateCodexSession(parsed.session!);
    expect(issues.some((i) => i.code === "codex.duplicate_call_id" && i.severity === "warning")).toBe(true);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });
});
