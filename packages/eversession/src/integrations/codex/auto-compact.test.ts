import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getSessionDir } from "../claude/eversession-session-storage.js";
import { runCodexAutoCompactOnce } from "./auto-compact.js";

describe("integrations/codex/auto-compact", () => {
  it("estimates tokens with Anthropic tokenizer when token_count is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-codex-auto-compact-"));
    const cwd = join(base, "proj");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = randomUUID();
    const sessionPath = join(base, `rollout-2025-01-01T00-00-00-${sessionId}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: sessionId, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "world" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    try {
      const res = await runCodexAutoCompactOnce({
        cwd,
        codexSessionsDir: base,
        sessionId,
        sessionPath,
        amountMode: "tokens",
        amountRaw: "40%",
        model: "haiku",
        busyTimeoutMs: 2_000,
      });

      expect(res.result).toBe("not_triggered");
      expect(res.tokens).toBeTypeOf("number");
      expect(res.tokens).toBeGreaterThan(0);
      expect(res.threshold).toBeTypeOf("number");
    } finally {
      await fs.rm(getSessionDir(sessionId), { recursive: true, force: true });
    }
  });
});
