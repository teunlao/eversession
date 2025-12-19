import { describe, expect, it } from "vitest";

import { parseTokenThreshold } from "./threshold.js";

describe("core/threshold", () => {
  it("parses raw integers", () => {
    expect(parseTokenThreshold("140000")).toBe(140000);
  });

  it("parses k suffix", () => {
    expect(parseTokenThreshold("140k")).toBe(140000);
    expect(parseTokenThreshold("140.5k")).toBe(140500);
  });
});

