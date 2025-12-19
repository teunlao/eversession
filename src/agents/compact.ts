import type { Issue } from "../core/issues.js";
import type { CountOrPercent } from "../core/spec.js";

export type CompactPrepareParams = {
  amountRaw: string;
  amountMessagesRaw?: string;
  amountTokensRaw?: string;
  keepLast?: boolean;
  summary?: string;
  model?: string;
  json?: boolean;
  log?: (line: string) => void;
};

export type CompactPlan = {
  amount: CountOrPercent;
  summary: string;
  options?: Record<string, unknown>;
  postFixParams?: unknown;
};

export type CompactPrepareResult =
  | { ok: true; plan: CompactPlan }
  | { ok: false; issues: Issue[]; exitCode?: number };
