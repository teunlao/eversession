import { asString } from "../../core/json.js";
import type { Issue } from "../../core/issues.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import type { SuggestParams, Suggestion } from "../validate.js";
import {
  getEntryType,
  getUuid,
  getParentUuid,
  getMessage,
  getMessageRole,
  getContentBlocks,
  getToolUseIds,
  getToolResultIds,
  isThinkingBlock,
} from "./model.js";

function getAssistantMergeKey(entry: ClaudeEntryLine): string | undefined {
  const message = getMessage(entry);
  const msgId = message ? (asString(message.id) ?? undefined) : undefined;
  if (msgId) return msgId;
  return asString(entry.value.requestId) ?? undefined;
}

export function validateClaudeSession(session: ClaudeSession): Issue[] {
  const issues: Issue[] = [];

  for (const line of session.lines) {
    if (line.kind === "invalid_json") {
      issues.push({
        severity: "error",
        code: "claude.invalid_json_line",
        message: `[Claude] Invalid JSON on line ${line.line}: ${line.error}`,
        location: { kind: "line", path: session.path, line: line.line },
      });
    }
  }

  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");

  const ids = new Map<string, number[]>();
  for (const entry of entries) {
    const id = getUuid(entry);
    if (!id) continue;
    const arr = ids.get(id) ?? [];
    arr.push(entry.line);
    ids.set(id, arr);
  }
  for (const [id, lines] of ids.entries()) {
    if (lines.length <= 1) continue;
    issues.push({
      severity: "warning",
      code: "claude.duplicate_uuid",
      message: "[Claude] Duplicate uuid/messageId values found.",
      location: { kind: "entry", path: session.path, entryId: id },
      details: { lines: [...lines] },
    });
  }

  const knownIds = new Set(ids.keys());
  for (const entry of entries) {
    const parent = getParentUuid(entry);
    if (!parent) continue;
    if (knownIds.has(parent)) continue;
    issues.push({
      severity: "warning",
      code: "claude.broken_parent_chain",
      message: "[Claude] parentUuid points to a missing uuid/messageId (Claude API ignores this, but it breaks local chains).",
      location: { kind: "line", path: session.path, line: entry.line },
      details: { parentUuid: parent },
    });
  }

  const toolUses = new Map<string, number[]>();
  const toolResults = new Map<string, number[]>();

  for (const entry of entries) {
    for (const id of getToolUseIds(entry)) {
      const arr = toolUses.get(id) ?? [];
      arr.push(entry.line);
      toolUses.set(id, arr);
    }
    for (const id of getToolResultIds(entry)) {
      const arr = toolResults.get(id) ?? [];
      arr.push(entry.line);
      toolResults.set(id, arr);
    }
  }

  for (const [toolUseId, lines] of toolResults.entries()) {
    if (toolUses.has(toolUseId)) continue;
    const first = Math.min(...lines);
    issues.push({
      severity: "error",
      code: "claude.orphan_tool_result",
      message: "[Claude] tool_result has no matching tool_use (Anthropic API rejects this).",
      location: { kind: "line", path: session.path, line: first },
      details: { tool_use_id: toolUseId, lines: [...lines].sort((a, b) => a - b) },
    });
  }

  for (const [toolUseId, lines] of toolUses.entries()) {
    if (toolResults.has(toolUseId)) continue;
    const first = Math.min(...lines);
    issues.push({
      severity: "warning",
      code: "claude.orphan_tool_use",
      message: "[Claude] tool_use has no matching tool_result (may be in-progress or truncated).",
      location: { kind: "line", path: session.path, line: first },
      details: { tool_use_id: toolUseId, lines: [...lines].sort((a, b) => a - b) },
    });
  }

  for (const entry of entries) {
    if (getMessageRole(entry) !== "assistant") continue;
    const blocks = getContentBlocks(entry);
    if (blocks.length === 0) continue;

    const hasThinking = blocks.some((b) => isThinkingBlock(b));
    if (!hasThinking) continue;
    if (isThinkingBlock(blocks[0])) continue;

    const idx = blocks.findIndex((b) => isThinkingBlock(b));
    issues.push({
      severity: "error",
      code: "claude.thinking_block_order",
      message: "[Claude] thinking/redacted_thinking block exists but is not first (Anthropic API rejects this).",
      location: { kind: "line", path: session.path, line: entry.line },
      details: { firstBlockType: asString(blocks[0]?.type) ?? "unknown", thinkingIndex: idx },
    });
  }

  const uuidToEntry = new Map<string, ClaudeEntryLine>();
  for (const entry of entries) {
    const uuid = asString(entry.value.uuid);
    if (uuid) uuidToEntry.set(uuid, entry);
  }

  for (const entry of entries) {
    if (getMessageRole(entry) !== "assistant") continue;
    const parentUuid = getParentUuid(entry);
    if (!parentUuid) continue;
    const parent = uuidToEntry.get(parentUuid);
    if (!parent) continue;
    if (getMessageRole(parent) !== "assistant") continue;

    const parentBlocks = getContentBlocks(parent);
    const childBlocks = getContentBlocks(entry);
    const parentHasThinking = parentBlocks.some((b) => isThinkingBlock(b));
    const childHasThinking = childBlocks.some((b) => isThinkingBlock(b));

    if (!parentHasThinking && childHasThinking) {
      const parentFirst = parentBlocks[0];
      if (!isThinkingBlock(parentFirst)) {
        issues.push({
          severity: "error",
          code: "claude.thinking_block_order_merged",
          message:
            "[Claude] Assistant message with thinking is linked to an assistant parent without thinking; merged turn would violate thinking-first rule.",
          location: { kind: "line", path: session.path, line: entry.line },
          details: { parentLine: parent.line, parentFirstBlockType: asString(parentFirst?.type) ?? "unknown" },
        });
      }
    }
  }

  for (const entry of entries) {
    const role = getMessageRole(entry);
    if (role !== "assistant") continue;
    if (entry.value.isApiErrorMessage !== true) continue;
    issues.push({
      severity: "warning",
      code: "claude.api_error_message",
      message: "[Claude] Recorded API error message found (safe to remove).",
      location: { kind: "line", path: session.path, line: entry.line },
      details: { error: asString(entry.value.error) ?? undefined },
    });
  }

  for (const entry of entries) {
    const t = getEntryType(entry);
    if (!t) continue;
    if (t === "user" || t === "assistant" || t === "summary" || t === "file-history-snapshot") continue;
    issues.push({
      severity: "info",
      code: "claude.unknown_entry_type",
      message: "[Claude] Unknown entry type encountered; preserving as-is.",
      location: { kind: "line", path: session.path, line: entry.line },
      details: { type: t },
    });
  }

  const leaf = (() => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry) continue;
      const role = getMessageRole(entry);
      if (role !== "user" && role !== "assistant") continue;
      if (entry.value.isApiErrorMessage === true) continue;
      const uuid = getUuid(entry);
      if (!uuid) continue;
      return entry;
    }
    return undefined;
  })();

  if (leaf) {
    const uuidToEntry = new Map<string, ClaudeEntryLine>();
    for (const entry of entries) {
      const uuid = getUuid(entry);
      if (!uuid) continue;
      uuidToEntry.set(uuid, entry);
    }

    const chain: ClaudeEntryLine[] = [];
    const visited = new Set<string>();
    let currentUuid: string | undefined = getUuid(leaf);
    const maxHops = 10_000;
    for (let hops = 0; hops < maxHops && currentUuid; hops += 1) {
      if (visited.has(currentUuid)) break;
      visited.add(currentUuid);
      const current = uuidToEntry.get(currentUuid);
      if (!current) break;
      chain.push(current);
      currentUuid = getParentUuid(current);
    }

    type PromptMessage = {
      kind: "assistant" | "user";
      lineNumbers: number[];
      blocks: ReturnType<typeof getContentBlocks>;
      mergeKey?: string;
      hasToolResult?: boolean;
    };

    const prompt: PromptMessage[] = [];

    const pushUser = (entry: ClaudeEntryLine): void => {
      prompt.push({
        kind: "user",
        lineNumbers: [entry.line],
        blocks: getContentBlocks(entry),
        hasToolResult: getToolResultIds(entry).length > 0,
      });
    };

    const pushAssistant = (entry: ClaudeEntryLine): void => {
      const mergeKey = getAssistantMergeKey(entry);
      const blocks = getContentBlocks(entry);
      const msg: PromptMessage = mergeKey
        ? { kind: "assistant", lineNumbers: [entry.line], blocks, mergeKey }
        : { kind: "assistant", lineNumbers: [entry.line], blocks };

      for (let i = prompt.length - 1; i >= 0; i -= 1) {
        const prev = prompt[i];
        if (!prev) continue;

        const canSkip = prev.kind === "user" && prev.hasToolResult === true;
        if (prev.kind !== "assistant" && !canSkip) break;

        if (prev.kind === "assistant") {
          if (mergeKey && prev.mergeKey === mergeKey) {
            // Chain goes leaf→root, so current entry is EARLIER in time
            // Prepend current blocks to preserve chronological order
            prev.blocks = [...blocks, ...prev.blocks];
            prev.lineNumbers.unshift(entry.line);
          } else {
            prompt.push(msg);
          }
          return;
        }
      }

      prompt.push(msg);
    };

    for (const entry of chain) {
      const t = getEntryType(entry);
      if (t === "system" || t === "progress") continue;
      if (entry.value.isApiErrorMessage === true) continue;

      const role = getMessageRole(entry);
      if (role === "user") {
        pushUser(entry);
        continue;
      }
      if (role === "assistant") {
        pushAssistant(entry);
      }
    }

    let violationCount = 0;
    const samples: Array<{
      index: number;
      firstBlockType: string;
      thinkingIndex: number;
      mergeKey?: string;
      lineNumbers: number[];
    }> = [];

    for (const [idx, m] of prompt.entries()) {
      if (m.kind !== "assistant") continue;
      const blocks = m.blocks;
      if (blocks.length === 0) continue;
      const hasThinking = blocks.some((b) => isThinkingBlock(b));
      if (!hasThinking) continue;
      if (isThinkingBlock(blocks[0])) continue;
      violationCount += 1;
      if (samples.length < 5) {
        samples.push({
          index: idx,
          firstBlockType: asString(blocks[0]?.type) ?? "unknown",
          thinkingIndex: blocks.findIndex((b) => isThinkingBlock(b)),
          lineNumbers: m.lineNumbers,
          ...(m.mergeKey ? { mergeKey: m.mergeKey } : {}),
        });
      }
    }

    if (violationCount > 0) {
      const sample = samples[0]!;
      issues.push({
        severity: "error",
        code: "claude.thinking_block_order_resume_chain",
        message:
          "[Claude] Session may trigger Anthropic API error on resume: assistant content contains thinking blocks but does not start with thinking (when reconstructed from the leaf parentUuid chain).",
        location: { kind: "line", path: session.path, line: sample.lineNumbers[0] ?? leaf.line },
        details: {
          leafUuid: getUuid(leaf),
          leafLine: leaf.line,
          violations: violationCount,
          sample: {
            promptIndex: sample.index,
            mergeKey: sample.mergeKey,
            firstBlockType: sample.firstBlockType,
            thinkingIndex: sample.thinkingIndex,
            contributingLines: sample.lineNumbers,
          },
        },
      });
    }
  }

  return issues;
}

export function suggestClaudeNextSteps(session: ClaudeSession, params: SuggestParams): Suggestion[] {
  const out: Suggestion[] = [];
  const targetPath = session.path;

  if (params.issues.some((i) => i.severity === "error")) {
    out.push({
      command: `evs fix ${JSON.stringify(targetPath)}`,
      reason: "Validation reported errors; try safe auto-fixes.",
    });
  }

  return out;
}
