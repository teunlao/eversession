import { asString, isJsonObject } from "../../core/json.js";
import type { ClaudeEntryLine } from "./session.js";

export type ContentBlock = Record<string, unknown>;

export function getEntryType(entry: ClaudeEntryLine): string | undefined {
  return asString(entry.value.type) ?? undefined;
}

export function getUuid(entry: ClaudeEntryLine): string | undefined {
  // `uuid` is the primary identifier used for parentUuid chains.
  // `messageId` is used by some auxiliary entries (e.g. file-history-snapshot) and can collide with uuids.
  return asString(entry.value.uuid) ?? undefined;
}

export function getParentUuid(entry: ClaudeEntryLine): string | undefined {
  return asString(entry.value.parentUuid) ?? undefined;
}

export function getMessage(entry: ClaudeEntryLine): Record<string, unknown> | undefined {
  if (!isJsonObject(entry.value.message)) return undefined;
  return entry.value.message;
}

export function getMessageRole(entry: ClaudeEntryLine): string | undefined {
  const message = getMessage(entry);
  return message ? asString(message.role) ?? undefined : undefined;
}

export function getContentBlocks(entry: ClaudeEntryLine): ContentBlock[] {
  const message = getMessage(entry);
  if (!message) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (isJsonObject(item)) blocks.push(item);
  }
  return blocks;
}

export function setContentBlocks(entry: ClaudeEntryLine, blocks: ContentBlock[]): void {
  const message = getMessage(entry);
  if (!message) return;
  message.content = blocks;
}

export function getToolUseIds(entry: ClaudeEntryLine): string[] {
  const out: string[] = [];
  for (const b of getContentBlocks(entry)) {
    if (asString(b.type) !== "tool_use") continue;
    const id = asString(b.id);
    if (id) out.push(id);
  }
  return out;
}

export function getToolResultIds(entry: ClaudeEntryLine): string[] {
  const out: string[] = [];
  for (const b of getContentBlocks(entry)) {
    if (asString(b.type) !== "tool_result") continue;
    const id = asString(b.tool_use_id);
    if (id) out.push(id);
  }
  return out;
}

export function isThinkingBlock(block: ContentBlock | undefined): boolean {
  if (!block) return false;
  const t = asString(block.type);
  return t === "thinking" || t === "redacted_thinking";
}

export function partitionThinkingFirst(blocks: ContentBlock[]): ContentBlock[] {
  if (blocks.length === 0) return blocks;
  const thinking: ContentBlock[] = [];
  const rest: ContentBlock[] = [];
  for (const b of blocks) {
    if (isThinkingBlock(b)) thinking.push(b);
    else rest.push(b);
  }
  return thinking.length === 0 ? blocks : [...thinking, ...rest];
}

// ============================================
// Boundary & Visibility
// ============================================

/**
 * Check if entry is a compact_boundary.
 */
export function isCompactBoundary(entry: ClaudeEntryLine): boolean {
  return (
    asString(entry.value.type) === "system" &&
    asString(entry.value.subtype) === "compact_boundary"
  );
}

/**
 * Check if entry is a message (user or assistant).
 */
export function isMessage(entry: ClaudeEntryLine): boolean {
  const t = getEntryType(entry);
  return t === "user" || t === "assistant";
}

/**
 * Find the index of the last compact_boundary in the entries array.
 * Returns -1 if no boundary found.
 */
export function findLastBoundaryIndex(entries: ClaudeEntryLine[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isCompactBoundary(entry)) {
      return i;
    }
  }
  return -1;
}

/**
 * Get all compact_boundary entries.
 */
export function getBoundaries(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  return entries.filter(isCompactBoundary);
}

/**
 * Get "visible" entries - entries after the last compact_boundary.
 * If no boundary exists, returns all entries.
 */
export function getVisibleEntries(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  const lastBoundaryIdx = findLastBoundaryIndex(entries);
  return lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries;
}

/**
 * Get "visible" messages - messages (user + assistant) after the last compact_boundary.
 * If no boundary exists, returns all messages.
 */
export function getVisibleMessages(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  return getVisibleEntries(entries).filter(isMessage);
}

// ============================================
// ParentUuid Chain
// ============================================

function getLeafUuidFromFileOrder(entries: ClaudeEntryLine[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    const uuid = asString(e.value.uuid);
    if (uuid) return uuid;
  }
  return undefined;
}

function getLeafUuidLikeClaude(entries: ClaudeEntryLine[]): string | undefined {
  // Claude Code reconstructs the active conversation by:
  // 1) building a uuid -> entry map
  // 2) selecting a leaf uuid (uuid not referenced by any parentUuid)
  // 3) if multiple leafs exist, picking the one with the latest timestamp
  //
  // See reverse spec: `ncB(messagesMap)` behavior (2.0.72).
  const uuidToEntry = new Map<string, ClaudeEntryLine>();
  const parentUuids = new Set<string>();

  for (const e of entries) {
    const uuid = asString(e.value.uuid);
    if (uuid) uuidToEntry.set(uuid, e);
    const parentUuid = asString(e.value.parentUuid);
    if (parentUuid) parentUuids.add(parentUuid);
  }

  const leafCandidates: string[] = [];
  for (const uuid of uuidToEntry.keys()) {
    if (!parentUuids.has(uuid)) leafCandidates.push(uuid);
  }

  if (leafCandidates.length === 0) return getLeafUuidFromFileOrder(entries);
  if (leafCandidates.length === 1) return leafCandidates[0];

  let bestUuid: string | undefined;
  let bestTs = Number.NEGATIVE_INFINITY;
  let bestFileOrder = Number.NEGATIVE_INFINITY;

  const fileOrderIndex = new Map<string, number>();
  for (const [idx, e] of entries.entries()) {
    const uuid = asString(e.value.uuid);
    if (!uuid) continue;
    fileOrderIndex.set(uuid, idx);
  }

  for (const uuid of leafCandidates) {
    const entry = uuidToEntry.get(uuid);
    const tsRaw = entry ? asString(entry.value.timestamp) : undefined;
    const parsed = tsRaw ? Date.parse(tsRaw) : Number.NaN;
    const ts = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    const order = fileOrderIndex.get(uuid) ?? Number.NEGATIVE_INFINITY;

    if (ts > bestTs || (ts === bestTs && order > bestFileOrder)) {
      bestUuid = uuid;
      bestTs = ts;
      bestFileOrder = order;
    }
  }

  return bestUuid ?? getLeafUuidFromFileOrder(entries);
}

export function getChainEntries(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  const uuidToEntry = new Map<string, ClaudeEntryLine>();
  for (const e of entries) {
    const uuid = asString(e.value.uuid);
    if (uuid) uuidToEntry.set(uuid, e);
  }

  const leafUuid = getLeafUuidLikeClaude(entries);
  if (!leafUuid) return [];

  const chain: ClaudeEntryLine[] = [];
  const visited = new Set<string>();
  let current: string | null = leafUuid;

  const maxHops = 50000;
  for (let hops = 0; hops < maxHops; hops += 1) {
    if (current === null) break;
    if (visited.has(current)) break;
    visited.add(current);

    const entry = uuidToEntry.get(current);
    if (!entry) break;
    chain.push(entry);

    current = asString(entry.value.parentUuid) ?? null;
  }

  return chain.reverse();
}

export function getChainMessages(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  return getChainEntries(entries).filter(isMessage);
}

// ============================================
// Statistics
// ============================================

export interface BoundarySegment {
  boundaryLine: number;
  boundaryUuid: string;
  timestamp: string;
  entriesInSegment: number;
  messagesInSegment: number;
}

export interface SessionStats {
  totalEntries: number;
  boundaries: number;
  visibleEntries: number;
  visibleMessages: number;
  byType: Record<string, number>;
  toolUseBlocks: number;
  toolResultBlocks: number;
  segments: BoundarySegment[];
}

/**
 * Get comprehensive statistics about a session.
 */
export function getSessionStats(entries: ClaudeEntryLine[]): SessionStats {
  const byType: Record<string, number> = {};
  let toolUseBlocks = 0;
  let toolResultBlocks = 0;

  for (const entry of entries) {
    const t = getEntryType(entry) ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
    toolUseBlocks += getToolUseIds(entry).length;
    toolResultBlocks += getToolResultIds(entry).length;
  }

  const boundaryEntries = getBoundaries(entries);
  const visibleEntries = getVisibleEntries(entries);
  const visibleMessages = getVisibleMessages(entries);

  // Calculate segments between boundaries
  const segments: BoundarySegment[] = [];

  // Find all boundary indices
  const boundaryIndices: number[] = [];
  for (const [idx, entry] of entries.entries()) {
    if (isCompactBoundary(entry)) {
      boundaryIndices.push(idx);
    }
  }

  // Segment 0: entries BEFORE first boundary (if any)
  const firstBoundaryIdx = boundaryIndices[0];
  if (firstBoundaryIdx !== undefined) {
    const entriesBefore = entries.slice(0, firstBoundaryIdx);
    const messagesBefore = entriesBefore.filter(isMessage);

    segments.push({
      boundaryLine: 0,
      boundaryUuid: "(start)",
      timestamp: "",
      entriesInSegment: entriesBefore.length,
      messagesInSegment: messagesBefore.length,
    });
  }

  // Segments between boundaries
  for (const [i, boundaryIdx] of boundaryIndices.entries()) {
    const boundary = entries[boundaryIdx]!;
    const nextBoundaryIdx = boundaryIndices[i + 1] ?? entries.length;

    const segmentEntries = entries.slice(boundaryIdx + 1, nextBoundaryIdx);
    const segmentMessages = segmentEntries.filter(isMessage);

    segments.push({
      boundaryLine: boundary.line,
      boundaryUuid: asString(boundary.value.uuid) ?? "unknown",
      timestamp: asString(boundary.value.timestamp) ?? "",
      entriesInSegment: segmentEntries.length,
      messagesInSegment: segmentMessages.length,
    });
  }

  return {
    totalEntries: entries.length,
    boundaries: boundaryEntries.length,
    visibleEntries: visibleEntries.length,
    visibleMessages: visibleMessages.length,
    byType,
    toolUseBlocks,
    toolResultBlocks,
    segments,
  };
}
