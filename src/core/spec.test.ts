import { describe, expect, it } from "vitest";

import { parseCountOrPercent, parseLineSpec, parseTokensOrPercent } from "./spec.js";

describe("core/spec", () => {
  it("parses count values", () => {
    expect(parseCountOrPercent("0")).toEqual({ kind: "count", count: 0 });
    expect(parseCountOrPercent("42")).toEqual({ kind: "count", count: 42 });
    expect(parseCountOrPercent("  7 ")).toEqual({ kind: "count", count: 7 });
  });

  it("parses percent values", () => {
    expect(parseCountOrPercent("0%")).toEqual({ kind: "percent", percent: 0 });
    expect(parseCountOrPercent("20%")).toEqual({ kind: "percent", percent: 20 });
    expect(parseCountOrPercent("100%")).toEqual({ kind: "percent", percent: 100 });
    expect(parseCountOrPercent("  5% ")).toEqual({ kind: "percent", percent: 5 });
  });

  it("rejects invalid count/percent", () => {
    expect(() => parseCountOrPercent("-1")).toThrow();
    expect(() => parseCountOrPercent("10.5")).toThrow();
    expect(() => parseCountOrPercent("101%")).toThrow();
    expect(() => parseCountOrPercent("-1%")).toThrow();
    expect(() => parseCountOrPercent("abc")).toThrow();
  });

  it("parses tokens or percent", () => {
    expect(parseTokensOrPercent("0")).toEqual({ kind: "tokens", tokens: 0 });
    expect(parseTokensOrPercent("42000")).toEqual({ kind: "tokens", tokens: 42000 });
    expect(parseTokensOrPercent("30k")).toEqual({ kind: "tokens", tokens: 30000 });
    expect(parseTokensOrPercent("12.5k")).toEqual({ kind: "tokens", tokens: 12500 });
    expect(parseTokensOrPercent("  25% ")).toEqual({ kind: "percent", percent: 25 });
  });

  it("rejects invalid token amount", () => {
    expect(() => parseTokensOrPercent("")).toThrow();
    expect(() => parseTokensOrPercent("-1")).toThrow();
    expect(() => parseTokensOrPercent("101%")).toThrow();
    expect(() => parseTokensOrPercent("-1%")).toThrow();
    expect(() => parseTokensOrPercent("nope")).toThrow();
  });

  it("parses line specs (single + ranges)", () => {
    expect(parseLineSpec("1")).toEqual([1]);
    expect(parseLineSpec("1,2,5-7")).toEqual([1, 2, 5, 6, 7]);
    expect(parseLineSpec(" 2 - 4 ")).toEqual([2, 3, 4]);
  });

  it("rejects invalid line specs", () => {
    expect(() => parseLineSpec("")).toThrow();
    expect(() => parseLineSpec("0")).toThrow();
    expect(() => parseLineSpec("-1")).toThrow();
    expect(() => parseLineSpec("a")).toThrow();
    expect(() => parseLineSpec("3-1")).toThrow();
    expect(() => parseLineSpec("1-2-3")).toThrow();
  });
});
