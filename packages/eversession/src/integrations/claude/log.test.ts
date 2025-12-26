import { describe, expect, it } from "vitest";

import { formatClaudeAutoCompactLine, parseClaudeAutoCompactEntries } from "./log.js";

describe("integrations/claude/log", () => {
  it("prints stage and error for failed auto_compact entries", () => {
    const raw = [
      JSON.stringify({
        ts: "2025-12-21T18:21:34.352Z",
        event: "auto_compact",
        result: "failed",
        stage: "llm_summary",
        model: "haiku",
        error: "LLM call failed: rate limit\nretry later",
        threshold: 80_000,
        tokens: 127_500,
      }),
    ].join("\n");

    const entries = parseClaudeAutoCompactEntries(raw);
    expect(entries).toHaveLength(1);

    const line = formatClaudeAutoCompactLine(entries[0]!);
    expect(line).toContain("result=failed");
    expect(line).toContain("stage=llm_summary");
    expect(line).toContain("model=haiku");
    expect(line).toContain("error=");
    expect(line).not.toContain("\n");
  });
});
