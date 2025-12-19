import type { TokensOrPercent } from "./spec.js";

export type TokenRemovalPlan = {
  removeCount: number;
  maxRemovableCount: number;
  totalTokens: number;
  targetRemoveTokens: number;
  selectedRemoveTokens: number;
};

function safeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function planPrefixRemovalByTokens(params: {
  tokensPerMessage: readonly number[];
  amount: TokensOrPercent;
  keepLastMessages?: number;
}): TokenRemovalPlan {
  const tokensPerMessage = params.tokensPerMessage.map(safeNonNegativeInt);
  const totalTokens = tokensPerMessage.reduce((acc, n) => acc + n, 0);

  const targetRemoveTokens =
    params.amount.kind === "percent"
      ? Math.floor(totalTokens * (params.amount.percent / 100))
      : Math.min(params.amount.tokens, totalTokens);

  const keepLast = params.keepLastMessages;
  const maxRemovableCount =
    keepLast !== undefined && Number.isFinite(keepLast) && keepLast > 0
      ? Math.max(0, tokensPerMessage.length - Math.floor(keepLast))
      : tokensPerMessage.length;

  if (targetRemoveTokens <= 0 || maxRemovableCount <= 0) {
    return { removeCount: 0, maxRemovableCount, totalTokens, targetRemoveTokens, selectedRemoveTokens: 0 };
  }

  let selectedRemoveTokens = 0;
  let removeCount = 0;
  for (let i = 0; i < maxRemovableCount; i += 1) {
    selectedRemoveTokens += tokensPerMessage[i] ?? 0;
    removeCount = i + 1;
    if (selectedRemoveTokens >= targetRemoveTokens) break;
  }

  return { removeCount, maxRemovableCount, totalTokens, targetRemoveTokens, selectedRemoveTokens };
}
