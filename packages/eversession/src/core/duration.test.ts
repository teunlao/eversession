import { describe, expect, it } from "vitest";

import { parseDurationMs } from "./duration.js";

describe("core/duration", () => {
  it("parses ms", () => {
    expect(parseDurationMs("250ms")).toBe(250);
  });

  it("parses seconds", () => {
    expect(parseDurationMs("1s")).toBe(1000);
    expect(parseDurationMs("1.5s")).toBe(1500);
  });
});
