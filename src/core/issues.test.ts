import { describe, expect, it } from "vitest";

import { countBySeverity, type Issue } from "./issues.js";

describe("core/issues", () => {
  it("countBySeverity returns zeroed counts for empty list", () => {
    expect(countBySeverity([])).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("countBySeverity counts each severity", () => {
    const issues: Issue[] = [
      { severity: "error", code: "e1", message: "x" },
      { severity: "warning", code: "w1", message: "x" },
      { severity: "warning", code: "w2", message: "x" },
      { severity: "info", code: "i1", message: "x" },
      { severity: "error", code: "e2", message: "x" },
    ];
    expect(countBySeverity(issues)).toEqual({ error: 2, warning: 2, info: 1 });
  });
});
