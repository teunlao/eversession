import { describe, expect, it } from "vitest";

import { parseClaudeSessionFromValues } from "./session.js";
import { analyzeClaudeSession } from "./analyze.js";

describe("claude/analyze", () => {
  it("counts entry types and tool blocks", () => {
    const parsed = parseClaudeSessionFromValues("memory.jsonl", [
      {
        type: "file-history-snapshot",
        messageId: "snap1",
        snapshot: { messageId: "snap1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
        isSnapshotUpdate: false,
      },
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
      { type: "summary", summary: "compact", leafUuid: "u2" },
    ]);
    if (!parsed.session) throw new Error("parse failed");

    const report = analyzeClaudeSession(parsed.session);
    expect(report.entryTypeCounts["file-history-snapshot"]).toBe(1);
    expect(report.entryTypeCounts.user).toBe(2);
    expect(report.entryTypeCounts.assistant).toBe(1);
    expect(report.entryTypeCounts.summary).toBe(1);

    expect(report.toolStats.toolUseBlocks).toBe(1);
    expect(report.toolStats.toolResultBlocks).toBe(1);
    expect(report.toolStats.uniqueToolUseIds).toBe(1);
    expect(report.toolStats.uniqueToolResultIds).toBe(1);
    expect(report.sessionIds).toEqual(["s1"]);
  });

  it("detects sidechain and agent ids", () => {
    const parsed = parseClaudeSessionFromValues("memory.jsonl", [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        isSidechain: true,
        agentId: "a8f9b74",
        message: { role: "user", content: "Warmup" },
      },
    ]);
    if (!parsed.session) throw new Error("parse failed");

    const report = analyzeClaudeSession(parsed.session);
    expect(report.isSidechain).toBe(true);
    expect(report.agentIds).toEqual(["a8f9b74"]);
    expect(report.sessionIds).toEqual(["s1"]);
  });
});

