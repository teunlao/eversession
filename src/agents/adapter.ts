import type { Issue } from "../core/issues.js";
import type { ChangeSet } from "../core/changes.js";
import type { AgentId } from "./agent-id.js";
import type { ExportResult } from "./export.js";
import type { Suggestion, SuggestParams } from "./validate.js";
import type { AnalyzeDetail, AnalyzeParams } from "./analyze.js";
import type { CompactPrepareParams, CompactPrepareResult } from "./compact.js";

export type ParseResult<Session> =
  | { ok: true; session: Session; issues: Issue[] }
  | { ok: false; issues: Issue[] };

export type OpResult = { nextValues: unknown[]; changes: ChangeSet };
export type CleanResult = { matched: number; op?: OpResult };

export interface AgentAdapter<Session> {
  readonly id: AgentId;
  parse(path: string): Promise<ParseResult<Session>>;
  parseValues(path: string, values: unknown[]): ParseResult<Session>;
  validate(session: Session): Issue[];
  suggest?(session: Session, params: SuggestParams): Suggestion[];
  analyze(session: Session): unknown;
  analyzeDetail?(session: Session, params: AnalyzeParams): Promise<AnalyzeDetail> | AnalyzeDetail;
  prepareCompact?(session: Session, params: CompactPrepareParams): Promise<CompactPrepareResult> | CompactPrepareResult;
  stripNoise?(session: Session, params: unknown): OpResult;
  fix?(session: Session, params: unknown): OpResult;
  compact?(session: Session, params: unknown): OpResult;
  trim?(session: Session, params: unknown): OpResult;
  remove?(session: Session, params: unknown): OpResult;
  export?(session: Session, params: unknown): ExportResult;
  clean?(session: Session, params: unknown): CleanResult;
  migrate?(session: Session, params: unknown): OpResult;
}
