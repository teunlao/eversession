import { claudeAdapter } from "../../agents/claude/adapter.js";
import { analyzeClaudeSession } from "../../agents/claude/analyze.js";
import { countClaudeMessagesTokens } from "../../agents/claude/tokens.js";
import { countBySeverity, type Issue } from "../../core/issues.js";

export type ClaudeInfoResult =
  | { ok: true; report: ClaudeInfoReport; exitCode: number }
  | { ok: false; issues: Issue[]; exitCode: number };

export type ClaudeInfoReport = {
  agent: "claude";
  cwd: string;
  session: {
    path: string;
    id: string;
    method?: string;
    confidence?: string;
    mtime?: string;
    lastActivity?: string;
  };
  totals: {
    entries: number;
    visibleMessages: number;
    boundaries: number;
  };
  analysis: ReturnType<typeof analyzeClaudeSession>;
  tokens: number;
  issueCounts: ReturnType<typeof countBySeverity>;
  parseIssues: Issue[];
};

export async function buildClaudeInfoReport(params: {
  cwd: string;
  sessionPath: string;
  sessionId: string;
  method?: string;
  confidence?: string;
  mtime?: string;
  lastActivity?: string;
  isHookInvocation?: boolean;
}): Promise<ClaudeInfoResult> {
  const parsed = await claudeAdapter.parse(params.sessionPath);
  if (!parsed.ok) {
    const issues: Issue[] = [
      ...parsed.issues,
      {
        severity: "error",
        code: "claude.session_parse_failed",
        message: "[Claude] Failed to parse discovered session.",
        location: { kind: "file", path: params.sessionPath },
      },
    ];
    return { ok: false, issues, exitCode: params.isHookInvocation ? 0 : 1 };
  }

  const session = parsed.session;
  const validationIssues = claudeAdapter.validate(session);
  const issueCounts = countBySeverity(validationIssues);
  const analysis = analyzeClaudeSession(session);
  const tokens = await countClaudeMessagesTokens(session);
  const totalEntries = session.lines.filter((l) => l.kind === "entry").length;

  const report: ClaudeInfoReport = {
    agent: "claude",
    cwd: params.cwd,
    session: {
      path: params.sessionPath,
      id: params.sessionId,
      ...(params.method ? { method: params.method } : {}),
      ...(params.confidence ? { confidence: params.confidence } : {}),
      ...(params.mtime ? { mtime: params.mtime } : {}),
      ...(params.lastActivity ? { lastActivity: params.lastActivity } : {}),
    },
    totals: {
      entries: totalEntries,
      visibleMessages: analysis.visibleMessages,
      boundaries: analysis.boundaries,
    },
    analysis,
    tokens,
    issueCounts,
    parseIssues: parsed.issues,
  };

  const exitCode = params.isHookInvocation ? 0 : issueCounts.error > 0 ? 1 : parsed.issues.some((i) => i.severity === "error") ? 1 : 0;
  return { ok: true, report, exitCode };
}
