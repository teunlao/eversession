export type Severity = "error" | "warning" | "info";

export type Location =
  | { kind: "file"; path: string }
  | { kind: "line"; path: string; line: number }
  | { kind: "entry"; path: string; entryId: string }
  | { kind: "pair"; path: string; callId: string };

export type SuggestedFix =
  | { op: "fix"; id: string; description: string }
  | { op: "remove"; lines: number[]; description: string };

export type Issue = {
  severity: Severity;
  code: string;
  message: string;
  location?: Location;
  details?: Record<string, unknown>;
  suggestedFixes?: SuggestedFix[];
};

export type IssueReport = {
  issues: Issue[];
};

export function countBySeverity(issues: Issue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) out[issue.severity] += 1;
  return out;
}

