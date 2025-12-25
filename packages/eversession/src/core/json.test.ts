import { describe, expect, it } from "vitest";

import { asArray, asBoolean, asNumber, asString, isJsonObject } from "./json.js";

describe("core/json", () => {
  it("isJsonObject accepts plain objects and rejects arrays/null/primitives", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
    expect(isJsonObject(1)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
  });

  it("asString/asNumber/asBoolean narrow primitives", () => {
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();

    expect(asNumber(1)).toBe(1);
    expect(asNumber("1")).toBeUndefined();

    expect(asBoolean(true)).toBe(true);
    expect(asBoolean("true")).toBeUndefined();
  });

  it("asArray validates all items via guard", () => {
    const isNumber = (v: unknown): v is number => typeof v === "number";
    expect(asArray([1, 2, 3], isNumber)).toEqual([1, 2, 3]);
    expect(asArray([1, "x"], isNumber)).toBeUndefined();
    expect(asArray("not-array", isNumber)).toBeUndefined();
  });
});
