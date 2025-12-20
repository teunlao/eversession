import type { CountOrPercent } from "../../core/spec.js";
import type { AgentAdapter, OpResult, ParseResult } from "../adapter.js";
import type { AnalyzeParams } from "../analyze.js";
import type { CleanParams } from "../clean.js";
import type { CompactPrepareParams } from "../compact.js";
import type { SuggestParams } from "../validate.js";
import { analyzeClaudeSession, buildClaudeAnalyzeDetail } from "./analyze.js";
import { cleanClaudeSession } from "./clean.js";
import { compactClaudeSession, prepareClaudeCompact } from "./compact.js";
import { exportClaudeSession } from "./export.js";
import type { FixOptions } from "./fix.js";
import { fixClaudeSession } from "./fix.js";
import { removeClaudeLines, trimClaudeSession } from "./ops.js";
import type { ClaudeSession } from "./session.js";
import { parseClaudeSession, parseClaudeSessionFromValues } from "./session.js";
import { suggestClaudeNextSteps, validateClaudeSession } from "./validate.js";

export type ClaudeCompactParams = {
  amount: CountOrPercent;
  summary: string;
  options?: {
    keepLast?: boolean;
    preserveAssistantTurns?: boolean;
    removalMode?: "delete" | "tombstone";
  };
};

export type ClaudeTrimParams = {
  amount: CountOrPercent;
  options?: { keepLast?: boolean; preserveAssistantTurns?: boolean; autoFix?: boolean };
};

export type ClaudeRemoveParams = {
  lines: Set<number>;
  options?: {
    preserveAssistantTurns?: boolean;
    autoFix?: boolean;
    initialReason?: string;
    assistantTurnReason?: string;
  };
};

export const claudeAdapter = {
  id: "claude",
  async parse(path: string): Promise<ParseResult<ClaudeSession>> {
    const parsed = await parseClaudeSession(path);
    if (!parsed.session) return { ok: false, issues: parsed.issues };
    return { ok: true, session: parsed.session, issues: parsed.issues };
  },
  parseValues(path: string, values: unknown[]): ParseResult<ClaudeSession> {
    const parsed = parseClaudeSessionFromValues(path, values);
    if (!parsed.session) return { ok: false, issues: parsed.issues };
    return { ok: true, session: parsed.session, issues: parsed.issues };
  },
  validate(session: ClaudeSession) {
    return validateClaudeSession(session);
  },
  suggest(session: ClaudeSession, params: SuggestParams) {
    return suggestClaudeNextSteps(session, params);
  },
  analyze(session: ClaudeSession) {
    return analyzeClaudeSession(session);
  },
  async analyzeDetail(session: ClaudeSession, _params: AnalyzeParams) {
    return buildClaudeAnalyzeDetail(session);
  },
  fix(session: ClaudeSession, params: unknown): OpResult {
    const options = (params ?? {}) as FixOptions;
    return fixClaudeSession(session, options);
  },
  compact(session: ClaudeSession, params: unknown): OpResult {
    const input = params as ClaudeCompactParams;
    return compactClaudeSession(session, input.amount, input.summary, input.options);
  },
  async prepareCompact(session: ClaudeSession, params: CompactPrepareParams) {
    return prepareClaudeCompact(session, params);
  },
  trim(session: ClaudeSession, params: unknown): OpResult {
    const input = params as ClaudeTrimParams;
    return trimClaudeSession(session, input.amount, input.options);
  },
  remove(session: ClaudeSession, params: unknown): OpResult {
    const input = params as ClaudeRemoveParams;
    return removeClaudeLines(session, input.lines, input.options);
  },
  export(session: ClaudeSession, params: unknown) {
    return exportClaudeSession(session, params as { full?: boolean });
  },
  clean(session: ClaudeSession, params: unknown) {
    return cleanClaudeSession(session, params as CleanParams);
  },
} satisfies AgentAdapter<ClaudeSession>;
