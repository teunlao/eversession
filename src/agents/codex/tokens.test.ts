import { describe, expect, it } from "vitest";

import { planCodexRemovalByTokens } from "./tokens.js";

function estimateTokens(payload: Record<string, unknown>): number {
  const t = payload.t;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return 0;
  return Math.floor(t);
}

describe("agents/codex/tokens planCodexRemovalByTokens", () => {
  it("removes enough items to reach token target", () => {
    const items: Array<Record<string, unknown>> = [{ t: 10 }, { t: 10 }, { t: 10 }, { t: 10 }];
    const plan = planCodexRemovalByTokens({
      responseItems: items,
      amount: { kind: "tokens", tokens: 15 },
      estimateTokensFn: estimateTokens,
    });

    expect(plan.removeCount).toBe(2);
    expect(plan.targetRemoveTokens).toBe(15);
    expect(plan.selectedRemoveTokens).toBe(20);
  });

  it("supports percent amounts", () => {
    const items: Array<Record<string, unknown>> = [{ t: 10 }, { t: 10 }, { t: 10 }, { t: 10 }];
    const plan = planCodexRemovalByTokens({
      responseItems: items,
      amount: { kind: "percent", percent: 50 },
      estimateTokensFn: estimateTokens,
    });

    expect(plan.removeCount).toBe(2);
    expect(plan.targetRemoveTokens).toBe(20);
    expect(plan.selectedRemoveTokens).toBe(20);
  });
});

