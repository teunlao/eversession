import { describe, expect, it } from "vitest";

import { patienceDiff, summarizeDiff, type DiffLine } from "./diff.js";

function lines(values: string[]): DiffLine[] {
  return values.map((text, idx) => ({ line: idx + 1, text }));
}

describe("diff", () => {
  it("computes inserts and deletes", () => {
    const ops = patienceDiff(lines(["a", "b", "c"]), lines(["a", "c", "d"]));
    const summary = summarizeDiff(ops);
    expect(summary).toEqual({ equal: 2, insert: 1, delete: 1 });
    expect(ops.some((o) => o.kind === "delete" && o.text === "b")).toBe(true);
    expect(ops.some((o) => o.kind === "insert" && o.text === "d")).toBe(true);
  });

  it("falls back deterministically when there are no unique anchors", () => {
    const ops = patienceDiff(lines(["a", "a"]), lines(["a", "a", "a"]));
    const summary = summarizeDiff(ops);
    expect(summary).toEqual({ equal: 2, insert: 1, delete: 0 });
  });
});

