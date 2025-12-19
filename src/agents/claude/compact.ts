import crypto from "node:crypto";
import path from "node:path";

import type { Change, ChangeSet } from "../../core/changes.js";
import { asString } from "../../core/json.js";
import type { CountOrPercent } from "../../core/spec.js";
import { parseCountOrPercent, parseTokensOrPercent } from "../../core/spec.js";
import { findLastBoundaryIndex, getChainEntries, getChainMessages, getEntryType } from "./model.js";
import { generateClaudeSummary, type ModelType } from "./summary.js";
import { expandToPreserveToolPairs, relinkParentUuidsOnRemoval } from "./remove-utils.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import type { CompactPrepareParams, CompactPrepareResult } from "../compact.js";
import { tombstoneClaudeEntryMessage } from "./tombstone.js";
import { expandToFullAssistantTurns } from "./turns.js";
import { planClaudeRemovalByTokens } from "./tokens.js";

export type CompactResult = { nextValues: unknown[]; changes: ChangeSet };

const MODEL_TYPES = ["haiku", "sonnet", "opus"] as const;

function parseModelType(value: string | undefined): ModelType | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  for (const m of MODEL_TYPES) {
    if (trimmed === m) return m;
  }
  return undefined;
}

export async function prepareClaudeCompact(session: ClaudeSession, params: CompactPrepareParams): Promise<CompactPrepareResult> {
  const llmModel = parseModelType(params.model);
  if (params.model && !llmModel) {
    return {
      ok: false,
      exitCode: 2,
      issues: [
        {
          severity: "error",
          code: "core.invalid_model",
          message: `[Core] Unsupported model: ${params.model}. Expected one of: ${MODEL_TYPES.join(", ")}.`,
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  const hasManualSummary = params.summary && params.summary.length > 0;
  if (!hasManualSummary && !llmModel) {
    return {
      ok: false,
      exitCode: 2,
      issues: [
        {
          severity: "error",
          code: "core.compact_missing_summary",
          message: "[Core] `compact` requires --model <haiku|sonnet|opus> or --summary <text>.",
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const visibleMessages = getChainMessages(entries);

  let keepLast = params.keepLast ?? false;
  let removeCount = 0;
  let compactAmount: CountOrPercent;

  if (params.amountTokensRaw) {
    if (keepLast) {
      return {
        ok: false,
        exitCode: 2,
        issues: [
          {
            severity: "error",
            code: "core.compact_invalid_keep_last",
            message: "[Claude] --amount-tokens cannot be combined with --keep-last.",
            location: { kind: "file", path: session.path },
          },
        ],
      };
    }
    const tokenAmount = parseTokensOrPercent(params.amountTokensRaw);
    const plan = await planClaudeRemovalByTokens({ visibleMessages, amount: tokenAmount });
    removeCount = plan.removeCount;
    compactAmount = { kind: "count", count: removeCount };
    keepLast = false;
  } else {
    compactAmount = parseCountOrPercent(params.amountMessagesRaw ?? params.amountRaw);
    if (keepLast) {
      if (compactAmount.kind !== "count") {
        return {
          ok: false,
          exitCode: 2,
          issues: [
            {
              severity: "error",
              code: "core.compact_invalid_keep_last",
              message: "[Claude] --keep-last requires an integer count (percent not supported).",
              location: { kind: "file", path: session.path },
            },
          ],
        };
      }
      removeCount = Math.max(0, visibleMessages.length - compactAmount.count);
    } else if (compactAmount.kind === "percent") {
      removeCount = Math.floor(visibleMessages.length * (compactAmount.percent / 100));
    } else {
      removeCount = Math.min(compactAmount.count, visibleMessages.length);
    }
  }

  let finalSummary = params.summary;
  if (!finalSummary && llmModel) {
    const entriesToCompact = visibleMessages.slice(0, removeCount);
    if (params.log) params.log(`Generating summary via ${llmModel}...`);
    try {
      const result = await generateClaudeSummary(session, entriesToCompact, {
        model: llmModel,
      });
      finalSummary = result.summary;
      if (params.log) {
        params.log(`Summary generated (${result.tokenCount} tokens):`);
        params.log("─".repeat(50));
        params.log(result.summary);
        params.log("─".repeat(50));
        params.log("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        ok: false,
        exitCode: 1,
        issues: [
          {
            severity: "error",
            code: "core.llm_failed",
            message: `[Core] LLM summary generation failed: ${message}`,
            location: { kind: "file", path: session.path },
          },
        ],
      };
    }
  }

  if (!finalSummary) {
    return {
      ok: false,
      exitCode: 1,
      issues: [
        {
          severity: "error",
          code: "core.no_summary",
          message: "[Core] No summary available.",
          location: { kind: "file", path: session.path },
        },
      ],
    };
  }

  return {
    ok: true,
    plan: {
      amount: compactAmount,
      summary: finalSummary,
      options: { keepLast, preserveAssistantTurns: true },
      postFixParams: {
        // Compact should not opportunistically delete tool pairs or history.
        // We only apply thinking/streaming repairs to prevent resume-breaking API errors.
        removeOrphanToolResults: false,
        removeOrphanToolUses: false,
        removeApiErrorMessages: false,
        fixThinkingBlockOrder: true,
      },
    },
  };
}

function deriveOutputSessionId(sessionPath: string): string | undefined {
  const base = path.basename(sessionPath);
  if (!base) return undefined;
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function isRootUserEntry(entry: ClaudeEntryLine): boolean {
  if (getEntryType(entry) !== "user") return false;
  return entry.value.parentUuid === null || entry.value.parentUuid === undefined;
}

function findFirstSnapshotLine(entries: ClaudeEntryLine[]): ClaudeEntryLine | undefined {
  return entries.find((e) => asString(e.value.type) === "file-history-snapshot");
}

/**
 * Compact a Claude session.
 *
 * Behavior:
 * - Deletes the oldest N visible messages (user+assistant) from the current visible segment.
 * - Inserts a single plain `type:"user"` summary message in their place.
 * - Does not create `compact_boundary` markers.
 */
export function compactClaudeSession(
  session: ClaudeSession,
  amount: CountOrPercent,
  summary: string,
  options?: {
    keepLast?: boolean;
    preserveAssistantTurns?: boolean;
    removalMode?: "delete" | "tombstone";
  },
): CompactResult {
  const keepLast = options?.keepLast ?? false;
  const preserveAssistantTurns = options?.preserveAssistantTurns ?? true;
  const removalMode = options?.removalMode ?? "delete";

  const changes: Change[] = [];
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const metaRootUser = entries.find((e) => isRootUserEntry(e) && e.value.isMeta === true);
  const chainEntries = getChainEntries(entries);
  const lastBoundaryIdx = findLastBoundaryIndex(chainEntries);
  const lastBoundary = lastBoundaryIdx >= 0 ? chainEntries[lastBoundaryIdx] : undefined;
  const boundaryUuid = lastBoundary ? asString(lastBoundary.value.uuid) : undefined;

  // Claude Code context is based on a parentUuid-linked chain. Compact operates on that chain.
  const chainMessages = getChainMessages(entries);
  const visibleMessages =
    metaRootUser && !chainMessages.some((m) => m.line === metaRootUser.line) ? [metaRootUser, ...chainMessages] : chainMessages;

  const template = pickTemplate(entries);
  const outputSessionId = deriveOutputSessionId(session.path);
  const now = new Date().toISOString();

  // Calculate how many messages to compact (SAME for both modes!)
  let removeCount = 0;
  if (keepLast) {
    if (amount.kind !== "count") {
      throw new Error("[Claude] --keep-last requires an integer count (percent not supported).");
    }
    removeCount = Math.max(0, visibleMessages.length - amount.count);
  } else if (amount.kind === "percent") {
    removeCount = Math.floor(visibleMessages.length * (amount.percent / 100));
  } else {
    removeCount = Math.min(amount.count, visibleMessages.length);
  }

  if (removeCount <= 0) {
    return { nextValues: entries.map((e) => e.value), changes: { changes: [] } };
  }

  // Mark messages for compaction (from VISIBLE messages)
  const requested = new Set<number>(visibleMessages.slice(0, removeCount).map((e) => e.line));
  if (preserveAssistantTurns) {
    expandToFullAssistantTurns(entries, requested);
  }

  const reasons = expandToPreserveToolPairs(entries, requested);
  for (const line of requested) {
    const current = reasons.get(line);
    if (current === "Selected for removal.") reasons.set(line, "Compacted into summary.");
  }

  const toRemove = new Set<number>(reasons.keys());

  if (toRemove.size === 0) {
    return { nextValues: entries.map((e) => e.value), changes: { changes: [] } };
  }

  // ============================================
  // MODE 2: Partial compact (without boundary)
  // - DELETE old messages, summary = root
  // ============================================

  const rootUser = metaRootUser ?? chainEntries.find(isRootUserEntry) ?? entries.find(isRootUserEntry);
  const rootUserUuid = rootUser ? asString(rootUser.value.uuid) : undefined;
  const rootIsMeta = rootUser ? rootUser.value.isMeta === true : false;

  let summaryUuid: string = crypto.randomUUID();
  let summaryParentUuid: string | null = null;
  let summaryInsertionAfterLine: number | null = null;
  let rewriteRoot = false;

  if (lastBoundary) {
    summaryInsertionAfterLine = lastBoundary.line;
    summaryParentUuid = boundaryUuid ?? null;
  } else if (rootUser && rootUserUuid) {
    // Never delete the root user entry; Claude Code often relies on it.
    toRemove.delete(rootUser.line);
    reasons.delete(rootUser.line);

    if (rootIsMeta) {
      // Keep meta-root and insert summary right after it.
      summaryParentUuid = rootUserUuid;
      summaryInsertionAfterLine = rootUser.line;
    } else {
      // Replace root user message with summary to preserve root invariants.
      summaryUuid = rootUserUuid;
      summaryParentUuid = null;
      rewriteRoot = true;
      rootUser.value.type = "user";
      rootUser.value.parentUuid = null;
      rootUser.value.message = { role: "user", content: summary };
      changes.push({
        kind: "update_line",
        line: rootUser.line,
        reason: "Replaced root user message with compaction summary.",
      });
    }
  } else {
    // Broken / nonstandard session: synthesize a root summary after first snapshot if possible.
    const firstSnapshot = findFirstSnapshotLine(entries);
    summaryInsertionAfterLine = firstSnapshot?.line ?? 0;
    summaryParentUuid = null;
  }

  if (toRemove.size === 0 && !rewriteRoot) {
    return { nextValues: entries.map((e) => e.value), changes: { changes: [] } };
  }

  // Relink parentUuids for entries that reference removed entries.
  if (removalMode === "delete") {
    relinkParentUuidsOnRemoval(entries, toRemove, changes);
  }

  // First kept message chains from summary
  const firstKeptMessage = visibleMessages.find((m) => !toRemove.has(m.line) && (!rootUser || m.line !== rootUser.line));
  if (firstKeptMessage) {
    firstKeptMessage.value.parentUuid = summaryUuid;
    changes.push({
      kind: "update_line",
      line: firstKeptMessage.line,
      reason: "Relinked first kept message to compact summary.",
    });
  }

  // Output: summary + kept entries (removed entries are deleted)
  const nextValues: unknown[] = [];

  const summaryEntry =
    !rewriteRoot && summaryInsertionAfterLine !== null
      ? buildCompactSummaryEntry(template, {
        uuid: summaryUuid,
        timestamp: now,
        parentUuid: summaryParentUuid,
        summary,
      })
      : undefined;
  if (summaryEntry && outputSessionId) summaryEntry.sessionId = outputSessionId;
  let summaryInserted = rewriteRoot;

  const afterLine = summaryInsertionAfterLine ?? 0;
  if (!summaryInserted && afterLine === 0 && summaryEntry) {
    nextValues.push(summaryEntry);
    summaryInserted = true;
    changes.push({
      kind: "insert_after",
      afterLine: 0,
      reason: "Inserted compact summary.",
    });
  }

  // Then kept entries
  for (const line of session.lines) {
    if (line.kind !== "entry") {
      changes.push({
        kind: "delete_line",
        line: line.line,
        reason: "Dropped invalid JSON line.",
      });
      continue;
    }
    if (toRemove.has(line.line)) {
      if (removalMode === "tombstone") {
        tombstoneClaudeEntryMessage(line, "[compacted]");
        changes.push({
          kind: "update_line",
          line: line.line,
          reason: reasons.get(line.line) ?? "Compacted into summary (tombstoned).",
        });
      } else {
        changes.push({
          kind: "delete_line",
          line: line.line,
          reason: reasons.get(line.line) ?? "Compacted into summary.",
        });
        continue;
      }
    }
    nextValues.push(line.value);

    if (!summaryInserted && summaryEntry && line.line === afterLine) {
      nextValues.push(summaryEntry);
      summaryInserted = true;
      changes.push({
        kind: "insert_after",
        afterLine,
        reason: "Inserted compact summary.",
      });
    }
  }

  if (!summaryInserted && summaryEntry) {
    nextValues.push(summaryEntry);
    changes.push({
      kind: "insert_after",
      afterLine,
      reason: "Inserted compact summary.",
    });
  }

  return { nextValues, changes: { changes } };
}

function pickTemplate(entries: ClaudeEntryLine[]): Record<string, unknown> | undefined {
  for (const e of entries) {
    const sid = asString(e.value.sessionId);
    if (sid) return e.value;
  }
  return entries[0]?.value;
}

function buildCompactSummaryEntry(
  template: Record<string, unknown> | undefined,
  params: { uuid: string; timestamp: string; parentUuid: string | null; summary: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "user",
    uuid: params.uuid,
    parentUuid: params.parentUuid,
    timestamp: params.timestamp,
    message: { role: "user", content: params.summary },
  };
  copyEnvFields(template, out);
  return out;
}

function copyEnvFields(source: Record<string, unknown> | undefined, target: Record<string, unknown>): void {
  if (!source) return;
  const sessionId = asString(source.sessionId);
  const cwd = asString(source.cwd);
  const version = asString(source.version);
  const gitBranch = asString(source.gitBranch);
  const slug = asString(source.slug);
  const userType = asString(source.userType);

  if (sessionId) target.sessionId = sessionId;
  if (cwd) target.cwd = cwd;
  if (version) target.version = version;
  if (gitBranch !== undefined) target.gitBranch = gitBranch;
  if (slug) target.slug = slug;
  if (userType) target.userType = userType;

  target.isSidechain = false;
}
