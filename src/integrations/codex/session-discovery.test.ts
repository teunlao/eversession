import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverCodexSessionReport } from "./session-discovery.js";

function todayYyyyMmDd(): { yyyy: string; mm: string; dd: string } {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { yyyy: String(d.getFullYear()), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()) };
}

describe("codex session discovery", () => {
  it("overrides stale codex-state mapping when a newer cwd-matching session exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-codex-session-discovery-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const oldId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const newId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const tsOld = "2025-01-01T00:00:00Z";
    const tsNew = "2025-01-01T00:10:00Z";

    await writeFile(
      join(dayDir, `rollout-2025-01-01T00-00-00-${oldId}.jsonl`),
      [
        JSON.stringify({ timestamp: tsOld, type: "session_meta", payload: { id: oldId, timestamp: tsOld, cwd } }),
        JSON.stringify({
          timestamp: tsOld,
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 }, rate_limits: null },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await writeFile(
      join(dayDir, `rollout-2025-01-01T00-10-00-${newId}.jsonl`),
      [
        JSON.stringify({ timestamp: tsNew, type: "session_meta", payload: { id: newId, timestamp: tsNew, cwd } }),
        JSON.stringify({
          timestamp: tsNew,
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 20 }, model_context_window: 100 }, rate_limits: null },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const prev = process.env.EVS_CODEX_STATE_PATH;
    const statePath = join(base, "codex-state.json");
    process.env.EVS_CODEX_STATE_PATH = statePath;

    try {
      await writeFile(
        statePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: new Date(0).toISOString(),
            byCwd: {
              [cwd]: { threadId: oldId, updatedAt: new Date(0).toISOString() },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const report = await discoverCodexSessionReport({
        cwd,
        codexSessionsDir,
        fallback: true,
        lookbackDays: 30,
        maxCandidates: 50,
        tailLines: 50,
        validate: false,
      });

      expect(report.agent).toBe("codex");
      if (report.agent !== "codex") throw new Error("Expected Codex session");
      expect(report.session.id).toBe(newId);

      const updated = JSON.parse(await readFile(statePath, "utf8"));
      expect(updated.byCwd[cwd].threadId).toBe(newId);
    } finally {
      if (prev === undefined) delete process.env.EVS_CODEX_STATE_PATH;
      else process.env.EVS_CODEX_STATE_PATH = prev;
    }
  });
});
