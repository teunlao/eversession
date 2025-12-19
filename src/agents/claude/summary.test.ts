import { describe, expect, it } from "vitest";

import { formatEntriesForPrompt } from "./summary.js";
import type { ClaudeEntryLine } from "./session.js";

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
});

