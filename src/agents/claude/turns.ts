import { asString } from "../../core/json.js";
import { getMessageRole } from "./model.js";
import type { ClaudeEntryLine } from "./session.js";

export function expandToFullAssistantTurns(entries: ClaudeEntryLine[], toRemove: Set<number>): number {
  const uuidToEntry = new Map<string, ClaudeEntryLine>();
  for (const e of entries) {
    const uuid = asString(e.value.uuid);
    if (uuid) uuidToEntry.set(uuid, e);
  }

  const childrenByParent = new Map<string, ClaudeEntryLine[]>();
  for (const e of entries) {
    if (getMessageRole(e) !== "assistant") continue;
    const parentUuid = asString(e.value.parentUuid);
    if (!parentUuid) continue;
    const arr = childrenByParent.get(parentUuid) ?? [];
    arr.push(e);
    childrenByParent.set(parentUuid, arr);
  }

  const turns: number[][] = [];

  for (const e of entries) {
    if (getMessageRole(e) !== "assistant") continue;
    const uuid = asString(e.value.uuid);
    if (!uuid) continue;

    const parentUuid = asString(e.value.parentUuid);
    const parent = parentUuid ? uuidToEntry.get(parentUuid) : undefined;
    if (parent && getMessageRole(parent) === "assistant") continue;

    const visited = new Set<string>();
    const queue: string[] = [uuid];
    visited.add(uuid);

    const lines: number[] = [];
    const lineSet = new Set<number>();
    lines.push(e.line);
    lineSet.add(e.line);

    while (queue.length > 0) {
      const currentUuid = queue.shift();
      if (!currentUuid) continue;
      const kids = childrenByParent.get(currentUuid) ?? [];
      for (const child of kids) {
        if (lineSet.has(child.line)) continue;
        lines.push(child.line);
        lineSet.add(child.line);
        const childUuid = asString(child.value.uuid);
        if (!childUuid || visited.has(childUuid)) continue;
        visited.add(childUuid);
        queue.push(childUuid);
      }
    }

    if (lines.length > 1) turns.push(lines);
  }

  let added = 0;
  for (const turn of turns) {
    const intersects = turn.some((line) => toRemove.has(line));
    if (!intersects) continue;
    for (const line of turn) {
      if (toRemove.has(line)) continue;
      toRemove.add(line);
      added += 1;
    }
  }

  return added;
}
