import { describe, expect, it } from "vitest";
import { compactClaudeSession } from "./compact.js";
import { parseClaudeSessionFromValues } from "./session.js";
import { validateClaudeSession } from "./validate.js";

function mustParse(values: unknown[]) {
  const parsed = parseClaudeSessionFromValues("memory.jsonl", values);
  if (!parsed.session) throw new Error("failed to parse");
  return parsed.session;
}

function findByType(values: unknown[], type: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const v of values) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as Record<string, unknown>;
    if (obj.type === type) out.push(obj);
  }
  return out;
}

describe("claude/compact", () => {
  describe("partial compact (default, no boundary)", () => {
    it("rewrites non-meta root user into summary and chains kept from it", () => {
      const session = mustParse([
        {
          type: "file-history-snapshot",
          messageId: "snap1",
          snapshot: { messageId: "snap1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
          isSnapshotUpdate: false,
        },
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "Hi" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "s1",
          requestId: "r1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
        { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "s1", message: { role: "user", content: "Next" } },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          sessionId: "s1",
          requestId: "r2",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        },
      ]);

      // Compact first 2 messages (u1, a1), keep u2, a2
      const out = compactClaudeSession(session, { kind: "count", count: 2 }, "SUMMARY");
      const values = out.nextValues;

      // Snapshot should remain first (we rewrite the root user, not reorder)
      expect((values[0] as Record<string, unknown> | undefined)?.type).toBe("file-history-snapshot");

      // Root user is rewritten into summary (uuid preserved, parentUuid remains null)
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u1"),
      ).toBe(true);
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1"),
      ).toBe(false);

      // No boundary in partial mode
      const systemEntries = findByType(values, "system");
      const boundary = systemEntries.find((e) => e.subtype === "compact_boundary");
      expect(boundary).toBeFalsy();

      // Summary should be the rewritten root user (parentUuid: null)
      const userEntries = findByType(values, "user");
      const summaryUser = userEntries.find((e) => {
        const msg = e.message as unknown;
        if (typeof msg !== "object" || msg === null) return false;
        const m = msg as Record<string, unknown>;
        return m.role === "user" && m.content === "SUMMARY";
      });
      expect(summaryUser).toBeTruthy();
      expect(summaryUser?.parentUuid).toBe(null);
      expect(summaryUser?.uuid).toBe("u1");

      // First kept message should chain from summary
      const u2 = userEntries.find((e) => e.uuid === "u2");
      expect(u2).toBeTruthy();
      expect(u2?.parentUuid).toBe(summaryUser?.uuid);

      // Validation should pass
      const post = validateClaudeSession(mustParse(values));
      expect(post.some((i) => i.severity === "error")).toBe(false);
    });

    it("preserves a meta-root and inserts summary as its child", () => {
      const session = mustParse([
        {
          type: "user",
          uuid: "m1",
          parentUuid: null,
          isMeta: true,
          sessionId: "s1",
          message: { role: "user", content: "META ROOT" },
        },
        {
          type: "file-history-snapshot",
          messageId: "snap1",
          snapshot: { messageId: "snap1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
          isSnapshotUpdate: false,
        },
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "Hi" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "s1",
          requestId: "r1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
        { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "s1", message: { role: "user", content: "Next" } },
      ]);

      // Compact first 2 messages (m1, u1) - meta-root must never be removed
      const out = compactClaudeSession(session, { kind: "count", count: 2 }, "SUMMARY");
      const values = out.nextValues;

      // Meta-root preserved
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "m1"),
      ).toBe(true);

      // Summary inserted as child of meta-root
      const userEntries = findByType(values, "user");
      const summaryUser = userEntries.find((e) => {
        const msg = e.message as unknown;
        if (typeof msg !== "object" || msg === null) return false;
        const m = msg as Record<string, unknown>;
        return m.role === "user" && m.content === "SUMMARY";
      });
      expect(summaryUser).toBeTruthy();
      expect(summaryUser?.parentUuid).toBe("m1");

      // First kept message should chain from summary (u1 was compacted away)
      const a1 = findByType(values, "assistant").find((e) => e.uuid === "a1");
      expect(a1).toBeTruthy();
      expect(a1?.parentUuid).toBe(summaryUser?.uuid);

      // No boundary in partial mode
      const boundary = findByType(values, "system").find((e) => e.subtype === "compact_boundary");
      expect(boundary).toBeFalsy();

      const post = validateClaudeSession(mustParse(values));
      expect(post.some((i) => i.severity === "error")).toBe(false);
    });

    it("synthesizes a root summary when session has no root user", () => {
      const session = mustParse([
        {
          type: "file-history-snapshot",
          messageId: "snap1",
          snapshot: { messageId: "snap1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
          isSnapshotUpdate: false,
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "missing",
          sessionId: "s1",
          requestId: "r1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
      ]);

      const out = compactClaudeSession(session, { kind: "count", count: 1 }, "SUMMARY");
      const values = out.nextValues;

      // Snapshot still first, summary inserted after snapshot
      expect((values[0] as Record<string, unknown> | undefined)?.type).toBe("file-history-snapshot");

      const userEntries = findByType(values, "user");
      const summaryUser = userEntries.find((e) => {
        const msg = e.message as unknown;
        if (typeof msg !== "object" || msg === null) return false;
        const m = msg as Record<string, unknown>;
        return m.role === "user" && m.content === "SUMMARY";
      });
      expect(summaryUser).toBeTruthy();
      expect(summaryUser?.parentUuid).toBe(null);

      const post = validateClaudeSession(mustParse(values));
      expect(post.some((i) => i.severity === "error")).toBe(false);
    });

    it("supports tombstoning compacted entries to preserve uuid stability", () => {
      const session = mustParse([
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "Hi" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "s1",
          requestId: "r1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
        { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "s1", message: { role: "user", content: "BIG" } },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          sessionId: "s1",
          requestId: "r2",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        },
      ]);

      const out = compactClaudeSession(session, { kind: "count", count: 3 }, "SUMMARY", { removalMode: "tombstone" });
      const values = out.nextValues;

      // Root user is rewritten into summary (uuid preserved)
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u1"),
      ).toBe(true);

      // Compacted entries remain present (tombstoned), rather than being deleted.
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1"),
      ).toBe(true);
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u2"),
      ).toBe(true);

      // New entries can still reference tombstoned uuids without breaking parent chains.
      const appended = mustParse([
        ...values,
        { type: "user", uuid: "u3", parentUuid: "u2", sessionId: "s1", message: { role: "user", content: "after" } },
      ]);
      const post = validateClaudeSession(appended);
      expect(post.some((i) => i.code === "claude.broken_parent_chain")).toBe(false);
      expect(post.some((i) => i.severity === "error")).toBe(false);
    });
  });

  describe("sessions with an existing compact_boundary", () => {
    it("compacts only visible messages (after boundary) and inserts a plain summary user after the boundary", () => {
      const session = mustParse([
        {
          type: "file-history-snapshot",
          messageId: "snap1",
          snapshot: { messageId: "snap1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
          isSnapshotUpdate: false,
        },
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", message: { role: "user", content: "Hi" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "s1",
          requestId: "r1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "b1",
          parentUuid: null,
          sessionId: "s1",
          timestamp: "2025-12-16T00:00:01Z",
        },
        { type: "user", uuid: "u2", parentUuid: "b1", sessionId: "s1", message: { role: "user", content: "After" } },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          sessionId: "s1",
          requestId: "r2",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        },
        { type: "user", uuid: "u3", parentUuid: "a2", sessionId: "s1", message: { role: "user", content: "More" } },
      ]);

      const out = compactClaudeSession(session, { kind: "count", count: 2 }, "SUMMARY");
      const values = out.nextValues;

      // Messages before the boundary are untouched
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u1"),
      ).toBe(true);
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a1"),
      ).toBe(true);

      // Boundary remains
      const systemEntries = findByType(values, "system");
      const boundary = systemEntries.find((e) => e.subtype === "compact_boundary");
      expect(boundary).toBeTruthy();
      expect(boundary?.parentUuid).toBe(null);

      // Compacted messages (u2, a2) are deleted
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "u2"),
      ).toBe(false);
      expect(
        values.some((v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).uuid === "a2"),
      ).toBe(false);

      // Summary is inserted right after the boundary (as a plain user message)
      const userEntries = findByType(values, "user");
      const summaryEntry = userEntries.find((e) => {
        const msg = e.message as unknown;
        if (typeof msg !== "object" || msg === null) return false;
        const m = msg as Record<string, unknown>;
        return m.role === "user" && m.content === "SUMMARY";
      });
      expect(summaryEntry).toBeTruthy();
      expect(summaryEntry?.parentUuid).toBe("b1");

      const u3 = userEntries.find((e) => e.uuid === "u3");
      expect(u3).toBeTruthy();
      expect(u3?.parentUuid).toBe(summaryEntry?.uuid);

      // Validation should pass
      const post = validateClaudeSession(mustParse(values));
      expect(post.some((i) => i.severity === "error")).toBe(false);
    });
  });
});
