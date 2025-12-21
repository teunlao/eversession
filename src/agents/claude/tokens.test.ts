import { countTokens } from "@anthropic-ai/tokenizer";
import { describe, expect, it } from "vitest";

import { parseClaudeSessionFromValues } from "./session.js";
import { countClaudeMessagesTokens } from "./tokens.js";

describe("agents/claude/tokens countClaudeMessagesTokens", () => {
  it("counts full tool_result token contribution", async () => {
    const huge = Array.from({ length: 5000 }, () => "hello").join(" ");
    const raw = countTokens(huge);
    expect(raw).toBeGreaterThan(1024);

    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_result", tool_use_id: "t1", content: huge },
          ],
        },
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("hi\n") + countTokens("ok\n") + raw;
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 50);
  });

  it("does not explode on tool_result image base64 payloads", async () => {
    const base64 = "A".repeat(50_000);

    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
            },
          ],
        },
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("hi\n") + countTokens("ok\n") + countTokens("[image]\n");
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 50);
  });

  it("counts text parts inside tool_result content arrays", async () => {
    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "HELLO" }] }],
        },
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("hi\n") + countTokens("HELLO\n");
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 50);
  });

  it("counts toolUseResult when there is no tool_result block", async () => {
    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: { role: "user", content: "hi" },
        toolUseResult: [{ type: "text", text: "TOOL OUT" }],
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("hi\n") + countTokens("TOOL OUT\n") + countTokens("ok\n");
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 50);
  });

  it("does not double-count toolUseResult when tool_result is present", async () => {
    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "RESULT" }],
        },
        toolUseResult: [{ type: "text", text: "RESULT" }],
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("RESULT");
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 50);
  });

  it("counts only the reachable parentUuid chain (Claude Code style)", async () => {
    const values = [
      // Unreachable segment (not linked from the last entry)
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:00Z",
        message: { role: "user", content: "OLD" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:01Z",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "OLD2" }] },
      },
      // Reachable segment (leaf)
      {
        type: "user",
        uuid: "v1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:02Z",
        message: { role: "user", content: "NEW" },
      },
      {
        type: "assistant",
        uuid: "b1",
        parentUuid: "v1",
        sessionId: "s1",
        timestamp: "2025-12-18T00:00:03Z",
        requestId: "r2",
        message: { role: "assistant", content: [{ type: "text", text: "NEW2" }] },
      },
    ];

    const parsed = parseClaudeSessionFromValues("/tmp/session.jsonl", values);
    if (!parsed.session) throw new Error("Expected session");

    const total = await countClaudeMessagesTokens(parsed.session);
    const expected = countTokens("NEW\n") + countTokens("NEW2\n");
    expect(total).toBeGreaterThanOrEqual(expected);
    expect(total).toBeLessThanOrEqual(expected + 20);
  });
});
