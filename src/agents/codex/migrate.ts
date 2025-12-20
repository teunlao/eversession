import type { Change, ChangeSet } from "../../core/changes.js";
import { asString, isJsonObject } from "../../core/json.js";
import type { CodexLegacyMetaLine, CodexLegacyRecordLine, CodexSession, CodexUnknownJsonLine } from "./session.js";

export type MigrateResult = {
  nextValues: unknown[];
  changes: ChangeSet;
};

function extractCwdFromLegacyRecords(records: CodexLegacyRecordLine[]): string | undefined {
  const maxScan = Math.min(records.length, 200);
  for (let i = 0; i < maxScan; i += 1) {
    const rec = records[i];
    if (!rec) continue;
    const t = asString(rec.value.type);
    if (t !== "message") continue;
    const role = asString(rec.value.role);
    if (role !== "user") continue;
    const content = rec.value.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isJsonObject(item)) continue;
      if (asString(item.type) !== "input_text") continue;
      const text = asString(item.text);
      if (!text) continue;
      if (!text.includes("<environment_context>")) continue;
      const m = text.match(/<cwd>([^<]+)<\/cwd>/);
      const cwd = m?.[1];
      if (cwd) return cwd;
    }
  }
  return undefined;
}

export function migrateLegacyCodexToWrapped(session: CodexSession): MigrateResult {
  if (session.format !== "legacy") {
    return { nextValues: session.lines.map((l) => ("value" in l ? l.value : l.raw)), changes: { changes: [] } };
  }

  const changes: Change[] = [];
  const meta = session.lines.find((l): l is CodexLegacyMetaLine => l.kind === "legacy_meta");
  const records = session.lines.filter((l): l is CodexLegacyRecordLine => l.kind === "legacy_record");
  const unknown = session.lines.filter((l): l is CodexUnknownJsonLine => l.kind === "unknown_json");

  if (!meta) {
    changes.push({
      kind: "update_line",
      line: 0,
      reason: "Cannot migrate legacy file without meta line.",
    });
    return { nextValues: session.lines.map((l) => ("value" in l ? l.value : l.raw)), changes: { changes } };
  }

  if (unknown.length > 0) {
    const firstUnknown = unknown[0];
    if (!firstUnknown) {
      return { nextValues: session.lines.map((l) => ("value" in l ? l.value : l.raw)), changes: { changes } };
    }
    changes.push({
      kind: "update_line",
      line: firstUnknown.line,
      reason: "Legacy file contains unknown JSON lines; migration will drop them (kept in backup).",
    });
  }

  const legacyGit = isJsonObject(meta.value.git) ? meta.value.git : undefined;
  const legacyInstructions = meta.value.instructions === null ? null : asString(meta.value.instructions);
  const cwd = extractCwdFromLegacyRecords(records) ?? ".";

  const sessionMetaPayload: Record<string, unknown> = {
    id: meta.id,
    timestamp: meta.timestamp,
    cwd,
    originator: "context-reactor",
    cli_version: "0.1.0",
    instructions: legacyInstructions ?? null,
    source: "cli",
  };
  if (legacyGit) sessionMetaPayload.git = legacyGit;

  const envelopeTimestamp = meta.timestamp;

  const nextValues: unknown[] = [
    {
      timestamp: envelopeTimestamp,
      type: "session_meta",
      payload: sessionMetaPayload,
    },
  ];
  changes.push({
    kind: "update_line",
    line: meta.line,
    reason: "Converted legacy meta dict to wrapped session_meta rollout line.",
  });

  for (const rec of records) {
    const recordType = asString(rec.value.record_type);
    if (recordType) {
      changes.push({
        kind: "delete_line",
        line: rec.line,
        reason: "Dropped legacy record_type line during migration.",
      });
      continue;
    }

    const t = asString(rec.value.type);
    if (!t) {
      changes.push({
        kind: "delete_line",
        line: rec.line,
        reason: "Dropped legacy line without a `type` field during migration.",
      });
      continue;
    }

    nextValues.push({
      timestamp: envelopeTimestamp,
      type: "response_item",
      payload: rec.value,
    });
    changes.push({
      kind: "update_line",
      line: rec.line,
      reason: 'Wrapped legacy ResponseItem as {timestamp,type:"response_item",payload}.',
    });
  }

  return { nextValues, changes: { changes } };
}
