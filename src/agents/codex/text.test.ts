import { describe, expect, it } from "vitest";

import { getCodexMessageText, getCodexReasoningText } from "./text.js";

describe("codex text", () => {
  it("extracts message text from input/output blocks", () => {
    expect(
      getCodexMessageText({
        content: [
          { type: "input_text", text: "hello " },
          { type: "input_image", image_url: "data:..." },
          { type: "output_text", text: "world" },
        ],
      }),
    ).toBe("hello world");
  });

  it("extracts reasoning text from summary + content blocks", () => {
    expect(
      getCodexReasoningText({
        summary: [{ type: "summary_text", text: "sum" }],
        content: [
          { type: "reasoning_text", text: "r1" },
          { type: "text", text: "r2" },
        ],
      }),
    ).toBe("sum\nr1\nr2");
  });
});

