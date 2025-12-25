import type { Change } from "../../core/changes.js";
import { asString } from "../../core/json.js";
import { getToolResultIds, getToolUseIds } from "./model.js";
import type { ClaudeEntryLine } from "./session.js";

export function buildToolMaps(entries: ClaudeEntryLine[]): {
  toolUses: Map<string, Set<number>>;
  toolResults: Map<string, Set<number>>;
} {
  const toolUses = new Map<string, Set<number>>();
  const toolResults = new Map<string, Set<number>>();

  for (const entry of entries) {
    for (const id of getToolUseIds(entry)) {
      const set = toolUses.get(id) ?? new Set<number>();
      set.add(entry.line);
      toolUses.set(id, set);
    }
    for (const id of getToolResultIds(entry)) {
      const set = toolResults.get(id) ?? new Set<number>();
      set.add(entry.line);
      toolResults.set(id, set);
    }
  }

  return { toolUses, toolResults };
}

export function expandToPreserveToolPairs(entries: ClaudeEntryLine[], initial: Set<number>): Map<number, string> {
  const dropReasons = new Map<number, string>();
  const mark = (line: number, reason: string): void => {
    if (!dropReasons.has(line)) dropReasons.set(line, reason);
  };
  for (const line of initial) mark(line, "Selected for removal.");

  const { toolUses: allUses, toolResults: allResults } = buildToolMaps(entries);
  const toRemove = new Set(initial);

  const maxIterations = 100;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    let changed = false;

    for (const entry of entries) {
      if (!toRemove.has(entry.line)) continue;

      for (const id of getToolUseIds(entry)) {
        const partner = allResults.get(id);
        if (!partner) continue;
        for (const line of partner) {
          if (toRemove.has(line)) continue;
          toRemove.add(line);
          mark(line, "Removed to preserve tool_use/tool_result pairing.");
          changed = true;
        }
      }

      for (const id of getToolResultIds(entry)) {
        const partner = allUses.get(id);
        if (!partner) continue;
        for (const line of partner) {
          if (toRemove.has(line)) continue;
          toRemove.add(line);
          mark(line, "Removed to preserve tool_use/tool_result pairing.");
          changed = true;
        }
      }
    }

    const remaining = entries.filter((e) => !toRemove.has(e.line));
    const { toolUses: remainingUses, toolResults: remainingResults } = buildToolMaps(remaining);

    for (const [id, lines] of remainingResults.entries()) {
      if (remainingUses.has(id)) continue;
      for (const line of lines) {
        if (toRemove.has(line)) continue;
        toRemove.add(line);
        mark(line, "Removed tool_result that would be orphan after removals.");
        changed = true;
      }
    }

    if (!changed) break;
  }

  return dropReasons;
}

export function relinkParentUuidsOnRemoval(
  entries: ClaudeEntryLine[],
  toRemove: Set<number>,
  changes?: Change[],
): number {
  const removedParentMap = new Map<string, string | null>();
  for (const e of entries) {
    if (!toRemove.has(e.line)) continue;
    const uuid = asString(e.value.uuid);
    if (!uuid) continue;
    removedParentMap.set(uuid, asString(e.value.parentUuid) ?? null);
  }

  let relinked = 0;
  for (const e of entries) {
    if (toRemove.has(e.line)) continue;
    const parentUuid = asString(e.value.parentUuid);
    if (!parentUuid) continue;

    let current: string | null = parentUuid;
    let hops = 0;
    const maxHops = 100;
    while (current !== null && removedParentMap.has(current) && hops < maxHops) {
      current = removedParentMap.get(current) ?? null;
      hops += 1;
    }

    if (hops > 0) {
      e.value.parentUuid = current;
      relinked += 1;
      changes?.push({ kind: "update_line", line: e.line, reason: "Relinked parentUuid to skip removed entries." });
    }
  }

  return relinked;
}
