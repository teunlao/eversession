import { countBySeverity, type Issue } from "./issues.js";
import type { Change, ChangeSet } from "./changes.js";

export function printIssuesHuman(issues: Issue[]): void {
  for (const issue of issues) {
    const loc =
      issue.location?.kind === "line"
        ? `:${issue.location.line}`
        : issue.location?.kind === "pair"
          ? ` (call_id=${issue.location.callId})`
          : "";
    process.stderr.write(`[${issue.severity}] ${issue.code}${loc}: ${issue.message}\n`);
  }
  const counts = countBySeverity(issues);
  process.stderr.write(`\nSummary: errors=${counts.error} warnings=${counts.warning} info=${counts.info}\n`);
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export function compareErrorCounts(before: Issue[], after: Issue[]): { before: number; after: number } {
  const count = (items: Issue[]) => items.filter((i) => i.severity === "error").length;
  return { before: count(before), after: count(after) };
}

export function printChangesHuman(changeSet: ChangeSet, options?: { limit?: number }): void {
  process.stdout.write(`changes: ${changeSet.changes.length}\n`);
  const limit = options?.limit ?? changeSet.changes.length;
  for (const c of changeSet.changes.slice(0, limit)) {
    process.stdout.write(`- ${c.kind} line=${describeChangeLine(c)}: ${c.reason}\n`);
  }
  if (changeSet.changes.length > limit) {
    process.stdout.write(`- … (${changeSet.changes.length - limit} more)\n`);
  }
}

function describeChangeLine(change: Change): number {
  return change.kind === "insert_after" ? change.afterLine : change.line;
}
