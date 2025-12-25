import type { TokensOrPercent } from "../../core/spec.js";
import { planPrefixRemovalByTokens, type TokenRemovalPlan } from "../../core/tokens-removal.js";

const APPROX_BYTES_PER_TOKEN = 4;

function approxTokenCountFromBytes(byteCount: number): number {
  if (!Number.isFinite(byteCount) || byteCount <= 0) return 0;
  return Math.ceil(byteCount / APPROX_BYTES_PER_TOKEN);
}

export function approxCodexTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return approxTokenCountFromBytes(Buffer.byteLength(text, "utf8"));
}

export function estimateCodexResponseItemTokens(payload: Record<string, unknown>): number {
  let serialized = "";
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return 0;
  }
  if (!serialized) return 0;
  return approxCodexTokenCount(serialized);
}

export function planCodexRemovalByTokens(params: {
  responseItems: readonly Record<string, unknown>[];
  amount: TokensOrPercent;
  keepLastItems?: number;
  estimateTokensFn?: (payload: Record<string, unknown>) => number;
}): TokenRemovalPlan {
  const estimate = params.estimateTokensFn ?? estimateCodexResponseItemTokens;
  const tokensPerItem = params.responseItems.map((item) => estimate(item));
  return planPrefixRemovalByTokens({
    tokensPerMessage: tokensPerItem,
    amount: params.amount,
    ...(params.keepLastItems !== undefined ? { keepLastMessages: params.keepLastItems } : {}),
  });
}

