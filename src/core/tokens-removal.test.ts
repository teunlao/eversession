import { describe, expect, it } from "vitest";

import { planPrefixRemovalByTokens } from "./tokens-removal.js";

describe("core/tokens-removal planPrefixRemovalByTokens", () => {
  it("selects minimal prefix meeting token budget", () => {
    const plan = planPrefixRemovalByTokens({
      tokensPerMessage: [800, 10, 10, 10, 10],
      amount: { kind: "percent", percent: 25 },
    });

    expect(plan.totalTokens).toBe(840);
    expect(plan.targetRemoveTokens).toBe(210);
    expect(plan.removeCount).toBe(1);
    expect(plan.selectedRemoveTokens).toBe(800);
  });

  it("supports absolute token amounts", () => {
    const plan = planPrefixRemovalByTokens({
      tokensPerMessage: [10, 10, 10, 10],
      amount: { kind: "tokens", tokens: 15 },
    });

    expect(plan.totalTokens).toBe(40);
    expect(plan.targetRemoveTokens).toBe(15);
    expect(plan.removeCount).toBe(2);
    expect(plan.selectedRemoveTokens).toBe(20);
  });

  it("caps removal when keepLastMessages is set", () => {
    const plan = planPrefixRemovalByTokens({
      tokensPerMessage: [10, 10, 10, 10],
      amount: { kind: "percent", percent: 50 },
      keepLastMessages: 3,
    });

    expect(plan.maxRemovableCount).toBe(1);
    expect(plan.totalTokens).toBe(40);
    expect(plan.targetRemoveTokens).toBe(20);
    expect(plan.removeCount).toBe(1);
    expect(plan.selectedRemoveTokens).toBe(10);
  });

  it("returns 0 when target is 0", () => {
    const plan = planPrefixRemovalByTokens({
      tokensPerMessage: [10, 10, 10],
      amount: { kind: "percent", percent: 0 },
    });
    expect(plan.removeCount).toBe(0);
    expect(plan.selectedRemoveTokens).toBe(0);
  });
});
