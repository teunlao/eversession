import { describe, expect, it } from "vitest";
import type { ClaudeEntryLine } from "./session.js";
import { buildClaudeSummaryPrompt, fitClaudeEntriesToMaxPromptTokens, formatEntriesForPrompt } from "./summary.js";

describe("claude summary", () => {
  it("includes tool_use input so summaries can reference file paths", () => {
    const entries: ClaudeEntryLine[] = [
      {
        kind: "entry",
        line: 1,
        raw: "{}",
        value: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { path: "README.md" },
              },
            ],
          },
        },
      },
    ];

    const text = formatEntriesForPrompt(entries);
    expect(text).toContain("[tool: Read]");
    expect(text).toContain('"path":"README.md"');
  });

  it("fits entries to a max prompt token budget", () => {
    const big = Array.from({ length: 600 }, () => "hello").join(" ");
    const entries: ClaudeEntryLine[] = Array.from({ length: 6 }, (_, idx) => {
      const role = idx % 2 === 0 ? "user" : "assistant";
      const type = role;
      const line = idx + 1;
      return {
        kind: "entry",
        line,
        raw: "{}",
        value: {
          type,
          message: { role, content: big },
        },
      };
    });

    const tokens4 = buildClaudeSummaryPrompt(entries.slice(0, 4)).promptTokens;
    const tokens5 = buildClaudeSummaryPrompt(entries.slice(0, 5)).promptTokens;
    expect(tokens5).toBeGreaterThan(tokens4);

    const maxPromptTokens = tokens4 + Math.floor((tokens5 - tokens4) / 2);
    const fit = fitClaudeEntriesToMaxPromptTokens({ entries, requestedCount: 5, maxPromptTokens });

    expect(fit.requestedPromptTokens).toBe(tokens5);
    expect(fit.promptTokens).toBeLessThanOrEqual(maxPromptTokens);
    expect(fit.count).toBeLessThanOrEqual(4);

    const fitAll = fitClaudeEntriesToMaxPromptTokens({ entries, requestedCount: 5, maxPromptTokens: tokens5 });
    expect(fitAll.count).toBe(5);
  });
});
