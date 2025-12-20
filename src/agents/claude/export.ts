import type { ExportItem, ExportParams, ExportResult } from "../export.js";
import { getMessageRole } from "./model.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import { getClaudeEntryText } from "./text.js";

export function exportClaudeSession(session: ClaudeSession, params: ExportParams): ExportResult {
  const full = params.full ?? false;
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const items: ExportItem[] = [];

  for (const e of entries) {
    const role = getMessageRole(e);
    if (!role) continue;
    if (!full && role !== "user" && role !== "assistant") continue;

    const text = getClaudeEntryText(e);
    if (!full && text.trim().length === 0) continue;

    items.push({ kind: "message", role, text, line: e.line });
  }

  return { items, format: "jsonl" };
}
