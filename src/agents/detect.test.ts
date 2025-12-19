import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { detectSession } from "./detect.js";

async function writeTemp(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-detect-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

describe("detectSession", () => {
  it("returns unknown for empty files", async () => {
    const path = await writeTemp("");
    const detected = await detectSession(path);
    expect(detected.agent).toBe("unknown");
    expect(detected.confidence).toBe("low");
  });

  it("detects Codex wrapped sessions even with invalid JSON in the sample", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTemp(
      ["{not json", JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c1" } })].join("\n") + "\n",
    );
    const detected = await detectSession(path);
    expect(detected.agent).toBe("codex");
    expect(detected.format).toBe("wrapped");
    expect(detected.confidence).toBe("medium");
    expect(detected.notes?.join("\n")).toContain("invalid JSON");
  });

  it("detects Claude sessions by entry type", async () => {
    const path = await writeTemp(
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        parentUuid: null,
        message: { role: "assistant", content: "hello" },
      }) + "\n",
    );
    const detected = await detectSession(path);
    expect(detected.agent).toBe("claude");
    expect(detected.format).toBe("jsonl");
    expect(detected.confidence).toBe("medium");
  });
});

