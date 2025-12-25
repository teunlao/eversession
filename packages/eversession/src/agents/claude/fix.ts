import type { Change, ChangeSet } from "../../core/changes.js";
import { asString } from "../../core/json.js";
import {
  getContentBlocks,
  getMessage,
  getMessageRole,
  isThinkingBlock,
  partitionThinkingFirst,
  setContentBlocks,
} from "./model.js";
import { buildToolMaps, expandToPreserveToolPairs, relinkParentUuidsOnRemoval } from "./remove-utils.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import { tombstoneClaudeEntryMessage } from "./tombstone.js";

export type FixOptions = {
  removeOrphanToolResults?: boolean;
  removeOrphanToolUses?: boolean;
  removeApiErrorMessages?: boolean;
  fixThinkingBlockOrder?: boolean;
  repairBrokenParentUuids?: boolean;
  removalMode?: "delete" | "tombstone";
  /**
   * Hard mode: strip ALL thinking/redacted_thinking blocks from assistant messages.
   * This is a last-resort fix for API errors about thinking block order that cannot
   * be resolved by reordering. Claude loses internal reasoning but keeps all outputs.
   *
   * TODO: Consider moving to regular fix if this proves safe and useful for all cases.
   */
  stripThinkingBlocks?: boolean;
};

export type FixResult = {
  nextValues: unknown[];
  changes: ChangeSet;
};

function repairBrokenParentUuidsInPlace(entries: ClaudeEntryLine[], changes: Change[]): void {
  const known = new Set<string>();
  for (const e of entries) {
    const uuid = asString(e.value.uuid);
    if (uuid) known.add(uuid);
  }

  let lastUuid: string | null = null;
  for (const e of entries) {
    const parentUuid = asString(e.value.parentUuid);
    if (parentUuid && !known.has(parentUuid)) {
      e.value.parentUuid = lastUuid;
      changes.push({
        kind: "update_line",
        line: e.line,
        reason: "Repaired broken parentUuid chain by linking to the nearest previous uuid in file order.",
      });
    }

    const uuid = asString(e.value.uuid);
    if (uuid) lastUuid = uuid;
  }
}

function buildUuidToEntry(entries: ClaudeEntryLine[]): Map<string, ClaudeEntryLine> {
  const out = new Map<string, ClaudeEntryLine>();
  for (const e of entries) {
    const uuid = asString(e.value.uuid);
    if (uuid) out.set(uuid, e);
  }
  return out;
}

function getAssistantMergeKey(entry: ClaudeEntryLine): string | undefined {
  const message = getMessage(entry);
  const msgId = message ? (asString(message.id) ?? undefined) : undefined;
  if (msgId) return msgId;
  return asString(entry.value.requestId) ?? undefined;
}

function fixThinkingOrderInPlace(entries: ClaudeEntryLine[], changes: Change[]): void {
  for (const entry of entries) {
    if (getMessageRole(entry) !== "assistant") continue;
    const blocks = getContentBlocks(entry);
    if (blocks.length === 0) continue;
    if (!blocks.some((b) => isThinkingBlock(b))) continue;
    if (isThinkingBlock(blocks[0])) continue;

    setContentBlocks(entry, partitionThinkingFirst(blocks));
    changes.push({
      kind: "update_line",
      line: entry.line,
      reason: "Reordered assistant content blocks to put thinking/redacted_thinking first.",
    });
  }
}

function collapseAssistantStreamingChunks(
  entries: ClaudeEntryLine[],
  changes: Change[],
  dropInitial: Set<number>,
  dropReasons: Map<number, string>,
): void {
  const uuidToEntry = buildUuidToEntry(entries);

  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const entry = entries[idx];
    if (!entry) continue;
    if (dropInitial.has(entry.line)) continue;
    if (getMessageRole(entry) !== "assistant") continue;
    if (entry.value.isApiErrorMessage === true) continue;

    const mergeKey = getAssistantMergeKey(entry);
    if (!mergeKey) continue;

    let blocks = getContentBlocks(entry);
    if (blocks.length === 0) continue;
    let chainHasThinking = blocks.some((b) => isThinkingBlock(b));
    let allChunksStartWithThinking = isThinkingBlock(blocks[0]);

    let parentUuid = asString(entry.value.parentUuid) ?? undefined;
    const parents: ClaudeEntryLine[] = [];
    const visited = new Set<string>();

    while (parentUuid) {
      if (visited.has(parentUuid)) break;
      visited.add(parentUuid);

      const parent = uuidToEntry.get(parentUuid);
      if (!parent) break;
      if (getMessageRole(parent) !== "assistant") break;
      if (parent.value.isApiErrorMessage === true) break;

      const parentKey = getAssistantMergeKey(parent);
      if (!parentKey || parentKey !== mergeKey) break;

      const parentBlocks = getContentBlocks(parent);
      if (parentBlocks.length === 0) break;

      if (!chainHasThinking && parentBlocks.some((b) => isThinkingBlock(b))) chainHasThinking = true;
      allChunksStartWithThinking = allChunksStartWithThinking && isThinkingBlock(parentBlocks[0]);
      parents.push(parent);
      parentUuid = asString(parent.value.parentUuid) ?? undefined;
    }

    if (!chainHasThinking || parents.length === 0 || allChunksStartWithThinking) continue;

    for (const parent of parents) {
      const parentBlocks = getContentBlocks(parent);
      blocks = [...parentBlocks, ...blocks];
      setContentBlocks(parent, []);
      dropInitial.add(parent.line);
      if (!dropReasons.has(parent.line)) {
        dropReasons.set(parent.line, "Collapsed assistant streaming chunk into later assistant entry (resume-safe).");
      }
    }

    if (parents.length > 0) {
      setContentBlocks(entry, partitionThinkingFirst(blocks));
      changes.push({
        kind: "update_line",
        line: entry.line,
        reason: "Collapsed assistant streaming chunks into a single assistant entry to preserve thinking-first rule.",
      });
    }
  }
}

// Parent relinking lives in remove-utils.ts

/**
 * Strip ALL thinking/redacted_thinking blocks from assistant messages.
 * Last-resort fix for API errors about thinking block order.
 */
function stripThinkingBlocksFromAssistants(entries: ClaudeEntryLine[], changes: Change[]): void {
  for (const entry of entries) {
    if (getMessageRole(entry) !== "assistant") continue;
    const blocks = getContentBlocks(entry);
    if (blocks.length === 0) continue;

    const filtered = blocks.filter((b) => !isThinkingBlock(b));
    if (filtered.length === blocks.length) continue; // No thinking blocks

    // If all content was thinking, add placeholder
    const finalBlocks = filtered.length > 0 ? filtered : [{ type: "text", text: "(thinking removed)" }];

    setContentBlocks(entry, finalBlocks);
    changes.push({
      kind: "update_line",
      line: entry.line,
      reason: `Stripped ${blocks.length - filtered.length} thinking block(s) from assistant message (hard fix).`,
    });
  }
}

export function fixClaudeSession(session: ClaudeSession, options: FixOptions): FixResult {
  const changes: Change[] = [];
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");

  const removeOrphanToolResults = options.removeOrphanToolResults ?? true;
  const removeOrphanToolUses = options.removeOrphanToolUses ?? true;
  const removeApiErrorMessages = options.removeApiErrorMessages ?? true;
  const fixThinkingBlockOrder = options.fixThinkingBlockOrder ?? true;
  const repairBrokenParentUuids = options.repairBrokenParentUuids ?? true;
  const removalMode = options.removalMode ?? "delete";

  const dropInitial = new Set<number>();
  const dropReasons = new Map<number, string>();

  if (repairBrokenParentUuids) {
    repairBrokenParentUuidsInPlace(entries, changes);
  }

  if (fixThinkingBlockOrder) {
    fixThinkingOrderInPlace(entries, changes);
    collapseAssistantStreamingChunks(entries, changes, dropInitial, dropReasons);
  }

  // Hard mode: strip all thinking blocks (last resort for stubborn API errors)
  if (options.stripThinkingBlocks) {
    stripThinkingBlocksFromAssistants(entries, changes);
  }

  if (removeApiErrorMessages) {
    for (const entry of entries) {
      if (entry.value.isApiErrorMessage !== true) continue;
      dropInitial.add(entry.line);
      dropReasons.set(entry.line, "Removed recorded API error message.");
    }
  }

  const { toolUses, toolResults } = buildToolMaps(entries);

  if (removeOrphanToolResults) {
    for (const [id, lines] of toolResults.entries()) {
      if (toolUses.has(id)) continue;
      for (const line of lines) {
        dropInitial.add(line);
        dropReasons.set(line, `Removed orphan tool_result (tool_use_id=${id}).`);
      }
    }
  }

  if (removeOrphanToolUses) {
    for (const [id, lines] of toolUses.entries()) {
      if (toolResults.has(id)) continue;
      for (const line of lines) {
        dropInitial.add(line);
        dropReasons.set(line, `Removed orphan tool_use (id=${id}).`);
      }
    }
  }

  const expandedReasons = expandToPreserveToolPairs(entries, dropInitial);
  for (const [line, reason] of expandedReasons.entries()) {
    if (!dropReasons.has(line)) dropReasons.set(line, reason);
  }

  const toRemove = new Set<number>(dropReasons.keys());
  if (removalMode === "delete") {
    relinkParentUuidsOnRemoval(entries, toRemove, changes);
  }

  const nextValues: unknown[] = [];
  for (const original of session.lines) {
    if (original.kind !== "entry") {
      changes.push({
        kind: "delete_line",
        line: original.line,
        reason: "Dropped invalid JSON line (cannot be preserved in JSONL rewrite).",
      });
    }
  }

  for (const e of entries) {
    if (!toRemove.has(e.line)) {
      nextValues.push(e.value);
      continue;
    }

    if (removalMode === "tombstone") {
      tombstoneClaudeEntryMessage(e, "[removed]");
      changes.push({
        kind: "update_line",
        line: e.line,
        reason: dropReasons.get(e.line) ?? "Tombstoned entry to preserve uuid stability.",
      });
      nextValues.push(e.value);
      continue;
    }

    changes.push({
      kind: "delete_line",
      line: e.line,
      reason: dropReasons.get(e.line) ?? "Removed line.",
    });
  }

  return { nextValues, changes: { changes } };
}
