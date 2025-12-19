import { describe, expect, it } from "vitest";

import { parseClaudeSessionFromValues } from "./session.js";
import { validateClaudeSession } from "./validate.js";
import { fixClaudeSession } from "./fix.js";
import { removeClaudeLines, trimClaudeSession } from "./ops.js";

function mustParse(values: unknown[]) {
  const parsed = parseClaudeSessionFromValues("memory.jsonl", values);
  if (!parsed.session) throw new Error("failed to parse");
  return parsed.session;
}

function findEntry(values: unknown[], predicate: (v: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (const v of values) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as Record<string, unknown>;
    if (predicate(obj)) return obj;
  }
  return undefined;
}

describe("claude", () => {
  it("validates a minimal session", () => {
    const session = mustParse([
      {
        type: "file-history-snapshot",
        // Claude Code often uses `messageId` that matches the next user entry `uuid`.
        messageId: "u1",
        snapshot: { messageId: "u1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
        isSnapshotUpdate: false,
      },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-16T00:00:01Z",
        message: { role: "user", content: "Hello" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-16T00:00:02Z",
        requestId: "req1",
        message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      },
    ]);

    const issues = validateClaudeSession(session);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.code === "claude.duplicate_uuid")).toBe(false);
  });

  it("detects orphan tool_result as an error and fixes it", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        sessionId: "s1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }],
        },
      },
    ]);

    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.code === "claude.orphan_tool_result" && i.severity === "error")).toBe(true);

    const fixed = fixClaudeSession(session, {});
    const post = validateClaudeSession(mustParse(fixed.nextValues));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("repairs broken parentUuid chains", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "missing",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "s1", message: { role: "user", content: "next" } },
    ]);

    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.code === "claude.broken_parent_chain")).toBe(true);

    const fixed = fixClaudeSession(session, {});
    const postSession = mustParse(fixed.nextValues);
    const post = validateClaudeSession(postSession);
    expect(post.some((i) => i.code === "claude.broken_parent_chain")).toBe(false);

    const a1 = findEntry(fixed.nextValues, (v) => v.type === "assistant");
    expect(a1?.parentUuid).toBe("u1");
  });

  it("reorders thinking blocks to satisfy thinking-first rule", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "thinking", thinking: "hidden", signature: "sig" },
          ],
        },
      },
    ]);

    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.code === "claude.thinking_block_order" && i.severity === "error")).toBe(true);

    const fixed = fixClaudeSession(session, {});
    const assistant = findEntry(fixed.nextValues, (v) => v.type === "assistant");
    expect(assistant).toBeTruthy();
    const message = assistant?.message as unknown;
    expect(typeof message).toBe("object");
    expect(message).not.toBeNull();
    const content = (message as Record<string, unknown>).content as unknown;
    expect(Array.isArray(content)).toBe(true);
    const first = (content as unknown[])[0] as unknown;
    expect(typeof first).toBe("object");
    expect(first).not.toBeNull();
    expect((first as Record<string, unknown>).type).toBe("thinking");

    const post = validateClaudeSession(mustParse(fixed.nextValues));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("breaks merged assistant turns when thinking appears in a child assistant", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "prefix" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "late", signature: "sig" }] },
      },
    ]);

    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.code === "claude.thinking_block_order_merged" && i.severity === "error")).toBe(true);

    const fixed = fixClaudeSession(session, {});
    const values = fixed.nextValues;
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1")).toBe(false);

    const a2 = findEntry(values, (v) => v.type === "assistant" && v.uuid === "a2");
    expect(a2).toBeTruthy();
    expect(a2?.parentUuid).toBe("u1");
    const message = a2?.message as unknown;
    expect(typeof message).toBe("object");
    expect(message).not.toBeNull();
    const content = (message as Record<string, unknown>).content as unknown;
    expect(Array.isArray(content)).toBe(true);
    const first = (content as unknown[])[0] as unknown;
    expect(typeof first).toBe("object");
    expect(first).not.toBeNull();
    expect((first as Record<string, unknown>).type).toBe("thinking");

    const post = validateClaudeSession(mustParse(values));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("collapses streaming chunks and preserves thinking-first order", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { id: "msg1", role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        sessionId: "s1",
        requestId: "r1",
        message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a2",
        sessionId: "s1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }] },
      },
    ]);

    // Validate now correctly merges in chronological order, so no violation detected.
    // Fix still collapses streaming chunks for consistency.
    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.severity === "error")).toBe(false);

    const fixed = fixClaudeSession(session, {});
    const values = fixed.nextValues;
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1")).toBe(false);

    const a2 = findEntry(values, (v) => v.type === "assistant" && v.uuid === "a2");
    expect(a2).toBeTruthy();
    expect(a2?.parentUuid).toBe("u1");
    const message = a2?.message as unknown;
    expect(typeof message).toBe("object");
    expect(message).not.toBeNull();
    const content = (message as Record<string, unknown>).content as unknown;
    expect(Array.isArray(content)).toBe(true);
    const first = (content as unknown[])[0] as unknown;
    expect(typeof first).toBe("object");
    expect(first).not.toBeNull();
    expect((first as Record<string, unknown>).type).toBe("thinking");

    const post = validateClaudeSession(mustParse(values));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("does not remove tool_result when collapsing a streaming chunk that contains tool_use", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        sessionId: "s1",
        requestId: "r1",
        message: { id: "msg1", role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a2",
        sessionId: "s1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }] },
      },
    ]);

    const fixed = fixClaudeSession(session, {});
    const values = fixed.nextValues;
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u2")).toBe(true);

    const post = validateClaudeSession(mustParse(values));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("allows a streaming assistant turn to start with tool_use when no thinking exists", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a2",
        sessionId: "s1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }] },
      },
    ]);

    const pre = validateClaudeSession(session);
    expect(pre.some((i) => i.severity === "error")).toBe(false);

    const fixed = fixClaudeSession(session, {});
    const a1 = findEntry(fixed.nextValues, (v) => v.type === "assistant" && v.uuid === "a1");
    expect(a1).toBeTruthy();
    const message = a1?.message as unknown;
    expect(typeof message).toBe("object");
    expect(message).not.toBeNull();
    const content = (message as Record<string, unknown>).content as unknown;
    expect(Array.isArray(content)).toBe(true);
    const first = (content as unknown[])[0] as unknown;
    expect(typeof first).toBe("object");
    expect(first).not.toBeNull();
    expect((first as Record<string, unknown>).type).toBe("tool_use");

    const post = validateClaudeSession(mustParse(fixed.nextValues));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("relinks parentUuid when removing an api error message", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        isApiErrorMessage: true,
        error: "invalid_request",
        message: { role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: "s1",
        message: { role: "user", content: "continuing" },
      },
    ]);

    const fixed = fixClaudeSession(session, {});
    const u2 = findEntry(fixed.nextValues, (v) => v.type === "user" && v.uuid === "u2");
    expect(u2).toBeTruthy();
    expect(u2?.parentUuid).toBe("u1");
  });

  it("trim expands to preserve tool_use/tool_result pairs", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: "s1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ]);

    const trimmed = trimClaudeSession(session, { kind: "count", count: 2 });
    const values = trimmed.nextValues;
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u2")).toBe(false);

    const post = validateClaudeSession(mustParse(values));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });

  it("remove expands to full assistant turns by default", () => {
    const session = mustParse([
      { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "part1" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        sessionId: "s1",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "part2" }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a2",
        sessionId: "s1",
        message: { role: "user", content: "after" },
      },
    ]);

    const removed = removeClaudeLines(session, new Set([3]));
    const values = removed.nextValues;
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1")).toBe(false);
    expect(values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a2")).toBe(false);
    const u2 = findEntry(values, (v) => v.type === "user" && v.uuid === "u2");
    expect(u2?.parentUuid).toBe("u1");

    const post = validateClaudeSession(mustParse(values));
    expect(post.some((i) => i.severity === "error")).toBe(false);
  });
});
