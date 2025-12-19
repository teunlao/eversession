import type { AgentAdapter, ParseResult, OpResult } from "../adapter.js";
import type { CodexSession } from "./session.js";
import type { CountOrPercent } from "../../core/spec.js";
import type { FixOptions as FixCodexOptions } from "./fix.js";

import { parseCodexSession, parseCodexSessionFromValues } from "./session.js";
import { validateCodexSession, suggestCodexNextSteps } from "./validate.js";
import { analyzeCodexSession, buildCodexAnalyzeDetail } from "./analyze.js";
import { fixCodexSession } from "./fix.js";
import { compactCodexSession, prepareCodexCompact } from "./compact.js";
import { trimCodexSession, removeCodexLines, stripNoiseCodexSession } from "./ops.js";
import { migrateLegacyCodexToWrapped } from "./migrate.js";
import { exportCodexSession } from "./export.js";
import { cleanCodexSession } from "./clean.js";
import type { CleanParams } from "../clean.js";
import type { SuggestParams } from "../validate.js";
import type { AnalyzeParams } from "../analyze.js";
import type { CompactPrepareParams } from "../compact.js";

export type CodexCompactParams = {
  amount: CountOrPercent;
  summary: string;
  options?: { keepLast?: boolean };
};

export type CodexTrimParams = {
  amount: CountOrPercent;
  options?: { keepLast?: boolean };
};

export type CodexRemoveParams = {
  lines: Set<number>;
  options?: { preserveCallPairs?: boolean };
};

export type CodexMigrateParams = {
  to: "codex-wrapped";
};

export const codexAdapter = {
  id: "codex",
  async parse(path: string): Promise<ParseResult<CodexSession>> {
    const parsed = await parseCodexSession(path);
    if (!parsed.session) return { ok: false, issues: parsed.issues };
    return { ok: true, session: parsed.session, issues: parsed.issues };
  },
  parseValues(path: string, values: unknown[]): ParseResult<CodexSession> {
    const parsed = parseCodexSessionFromValues(path, values);
    if (!parsed.session) return { ok: false, issues: parsed.issues };
    return { ok: true, session: parsed.session, issues: parsed.issues };
  },
  validate(session: CodexSession) {
    return validateCodexSession(session);
  },
  suggest(session: CodexSession, params: SuggestParams) {
    return suggestCodexNextSteps(session, params);
  },
  analyze(session: CodexSession) {
    return analyzeCodexSession(session);
  },
  analyzeDetail(session: CodexSession, _params: AnalyzeParams) {
    return buildCodexAnalyzeDetail(session);
  },
  fix(session: CodexSession, params: unknown): OpResult {
    const options = (params ?? {}) as FixCodexOptions;
    return fixCodexSession(session, options);
  },
  compact(session: CodexSession, params: unknown): OpResult {
    const input = params as CodexCompactParams;
    return compactCodexSession(session, input.amount, input.summary, input.options);
  },
  prepareCompact(session: CodexSession, params: CompactPrepareParams) {
    return prepareCodexCompact(session, params);
  },
  trim(session: CodexSession, params: unknown): OpResult {
    const input = params as CodexTrimParams;
    return trimCodexSession(session, input.amount, input.options);
  },
  remove(session: CodexSession, params: unknown): OpResult {
    const input = params as CodexRemoveParams;
    return removeCodexLines(session, input.lines, input.options);
  },
  stripNoise(session: CodexSession, params: unknown): OpResult {
    const input = (params ?? {}) as { dropTurnContext?: boolean; dropEventMsg?: boolean; dropLegacyState?: boolean };
    return stripNoiseCodexSession(session, input);
  },
  export(session: CodexSession, params: unknown) {
    return exportCodexSession(session, params as { full?: boolean });
  },
  clean(session: CodexSession, params: unknown) {
    return cleanCodexSession(session, params as CleanParams);
  },
  migrate(session: CodexSession, params: unknown): OpResult {
    const input = params as CodexMigrateParams;
    if (input.to !== "codex-wrapped") {
      return { nextValues: session.lines.map((l) => ("value" in l ? l.value : l.raw)), changes: { changes: [] } };
    }
    return migrateLegacyCodexToWrapped(session);
  },
} satisfies AgentAdapter<CodexSession>;
