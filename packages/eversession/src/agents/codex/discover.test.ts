import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverCodexSession } from "./discover.js";

function todayYyyyMmDd(): { yyyy: string; mm: string; dd: string } {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { yyyy: String(d.getFullYear()), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()) };
}

describe("codex discover", () => {
  it("prefers cwd-matching sessions over fallback even when fallback is newer", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-codex-discover-"));
    const cwd = join(base, "proj");
    const otherCwd = join(base, "other");
    await mkdir(cwd, { recursive: true });
    await mkdir(otherCwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const idMatch = "11111111-1111-1111-1111-111111111111";
    const idFallback = "22222222-2222-2222-2222-222222222222";

    const tsOlder = "2025-01-01T00:00:00Z";
    const tsNewer = "2025-01-01T00:10:00Z";

    await writeFile(
      join(dayDir, `rollout-2025-01-01T00-00-00-${idMatch}.jsonl`),
      [
        JSON.stringify({ timestamp: tsOlder, type: "session_meta", payload: { id: idMatch, timestamp: tsOlder, cwd } }),
        JSON.stringify({
          timestamp: tsOlder,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { total_tokens: 1 }, model_context_window: 10 },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await writeFile(
      join(dayDir, `rollout-2025-01-01T00-10-00-${idFallback}.jsonl`),
      [
        JSON.stringify({
          timestamp: tsNewer,
          type: "session_meta",
          payload: { id: idFallback, timestamp: tsNewer, cwd: otherCwd },
        }),
        JSON.stringify({
          timestamp: tsNewer,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { total_tokens: 999 }, model_context_window: 1000 },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await discoverCodexSession({
      cwd,
      codexSessionsDir,
      fallback: true,
      lookbackDays: 30,
      maxCandidates: 50,
      tailLines: 50,
      validate: false,
    });

    expect(res.agent).toBe("codex");
    if (res.agent !== "codex") throw new Error("Expected Codex session");
    expect(res.session.id).toBe(idMatch);
    expect(res.method).toBe("cwd-hash");
    expect(res.confidence).toBe("high");
  });
});
