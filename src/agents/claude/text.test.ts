import { describe, expect, it } from "vitest";

import type { ClaudeEntryLine } from "./session.js";
import { getClaudeEntryText } from "./text.js";

describe("claude text", () => {
  it("extracts concatenated text blocks", () => {
    const entry: ClaudeEntryLine = {
      kind: "entry",
      line: 1,
      raw: "{}",
      value: {
        type: "assistant",
        uuid: "u1",
        parentUuid: null,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "shell_command" },
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      },
    };
    expect(getClaudeEntryText(entry)).toBe("hello world");
  });

  it("extracts string content", () => {
    const entry: ClaudeEntryLine = {
      kind: "entry",
      line: 1,
      raw: "{}",
      value: {
        type: "assistant",
        uuid: "u1",
        parentUuid: null,
        message: { role: "assistant", content: "hello from string" },
      },
    };
    expect(getClaudeEntryText(entry)).toBe("hello from string");
  });
});
