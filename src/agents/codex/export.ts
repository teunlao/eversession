import type { CodexLegacyRecordLine, CodexSession, CodexWrappedLine } from "./session.js";
import { getCodexMessageText, getCodexReasoningText } from "./text.js";
import { asString, isJsonObject } from "../../core/json.js";
import type { ExportItem, ExportParams, ExportResult } from "../export.js";

function extractSummaryFromReplacementHistory(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let idx = value.length - 1; idx >= 0; idx -= 1) {
    const item = value[idx];
    if (!isJsonObject(item)) continue;
    if (asString(item.type) !== "message") continue;
    if (asString(item.role) !== "user") continue;
    const text = getCodexMessageText(item);
    if (text) return text;
  }
  return undefined;
}

function codexResponseItemToExport(line: number, payload: Record<string, unknown>, full: boolean): ExportItem[] {
  const out: ExportItem[] = [];
  const t = asString(payload.type);
  if (t === "message") {
    const role = asString(payload.role);
    if (!role) return out;
    if (!full && role !== "user" && role !== "assistant") return out;
    const text = getCodexMessageText(payload);
    if (!full && text.trim().length === 0) return out;
    out.push({ kind: "message", role, text, line });
    return out;
  }

  if (t === "reasoning") {
    if (!full) return out;
    const text = getCodexReasoningText(payload);
    if (!text) return out;
    out.push({ kind: "reasoning", text, line });
    return out;
  }

  const callName = t === "function_call" ? asString(payload.name) : undefined;
  if ((t === "function_call" || t === "custom_tool_call" || t === "local_shell_call") && full) {
    out.push({
      kind: "tool",
      name: callName ?? t,
      text: JSON.stringify(payload),
      line,
    });
    return out;
  }
  if ((t === "function_call_output" || t === "custom_tool_call_output") && full) {
    out.push({ kind: "tool", name: t, text: JSON.stringify(payload), line });
  }

  return out;
}

function extractCodexExportItemsWrapped(lines: CodexWrappedLine[], full: boolean): ExportItem[] {
  const out: ExportItem[] = [];

  for (const line of lines) {
    if (line.type === "response_item") {
      if (!isJsonObject(line.payload)) continue;
      out.push(...codexResponseItemToExport(line.line, line.payload, full));
      continue;
    }

    if (line.type === "compacted") {
      if (!isJsonObject(line.payload)) continue;
      const msg = asString(line.payload.message) ?? "";
      const fromHistory = extractSummaryFromReplacementHistory(line.payload.replacement_history);
      const text = msg || fromHistory;
      if (!text) {
        if (full) out.push({ kind: "compacted", text: JSON.stringify(line.payload), line: line.line });
      } else {
        out.push({ kind: "compacted", text, line: line.line });
      }
    }
  }

  return out;
}

function extractCodexExportItemsLegacy(records: CodexLegacyRecordLine[], full: boolean): ExportItem[] {
  const out: ExportItem[] = [];
  for (const rec of records) {
    if (asString(rec.value.record_type)) continue;
    const t = asString(rec.value.type);
    if (!t) continue;
    out.push(...codexResponseItemToExport(rec.line, rec.value, full));
  }
  return out;
}

export function exportCodexSession(session: CodexSession, params: ExportParams): ExportResult {
  const full = params.full ?? false;
  const items: ExportItem[] =
    session.format === "wrapped"
      ? extractCodexExportItemsWrapped(
          session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped"),
          full,
        )
      : extractCodexExportItemsLegacy(
          session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record"),
          full,
        );

  return { items, format: session.format };
}
