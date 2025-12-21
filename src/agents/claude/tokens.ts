/**
 * Token counting utilities
 */

import { countTokens as anthropicCountTokens, getTokenizer } from "@anthropic-ai/tokenizer";
import { asString } from "../../core/json.js";
import type { TokensOrPercent } from "../../core/spec.js";
import { planPrefixRemovalByTokens, type TokenRemovalPlan } from "../../core/tokens-removal.js";
import { getChainMessages } from "./model.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";

type Tokenizer = ReturnType<typeof getTokenizer>;

function countTokensWithTokenizer(tokenizer: Tokenizer, text: string): number {
  if (text.length === 0) return 0;
  return tokenizer.encode(text.normalize("NFKC"), "all").length;
}

function getToolResultTokenSegments(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const segments: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    const type = asString(p.type);

    if (type === "text") {
      const text = asString(p.text);
      if (!text) continue;
      segments.push(ensureTrailingNewline(text));
      continue;
    }

    if (type === "image") {
      // Claude Code `/context → Messages` token usage does not scale with base64 payload size.
      // Represent images as a tiny placeholder to avoid runaway counts.
      segments.push("[image]\n");
      continue;
    }
  }

  return segments;
}

function countTokensForClaudeMessage(entry: ClaudeEntryLine, tokenizer: Tokenizer): number {
  const entryType = asString(entry.value.type);
  if (entryType !== "user" && entryType !== "assistant") return 0;

  const message = entry.value.message;
  if (typeof message !== "object" || message === null) return 0;
  const msgObj = message as Record<string, unknown>;

  const content = msgObj.content;

  if (typeof content === "string") {
    return countTokensWithTokenizer(tokenizer, content.endsWith("\n") ? content : `${content}\n`);
  }

  if (!Array.isArray(content)) return 0;

  let tokens = 0;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const t = asString(b.type);

    if (t === "text") {
      const text = asString(b.text);
      if (text) tokens += countTokensWithTokenizer(tokenizer, text.endsWith("\n") ? text : `${text}\n`);
      continue;
    }

    if (t === "tool_use") {
      const name = asString(b.name);
      if (!name) continue;
      tokens += countTokensWithTokenizer(tokenizer, `[tool: ${name}]\n`);
      if ("input" in b) tokens += countTokensWithTokenizer(tokenizer, JSON.stringify(b.input) + "\n");
      continue;
    }

    if (t === "tool_result") {
      for (const segment of getToolResultTokenSegments(b.content)) {
        tokens += countTokensWithTokenizer(tokenizer, segment);
      }
      continue;
    }
  }

  return tokens;
}

/**
 * Count tokens in a string using Anthropic's tokenizer.
 *
 * We intentionally avoid heuristic fallbacks: if token counting is wrong, it is better
 * to fail loudly than to silently produce misleading numbers.
 */
export async function countTokens(text: string): Promise<number> {
  return anthropicCountTokens(text);
}

/**
 * Count tokens for Claude Code `/context → Messages`.
 *
 * Claude Code effectively tracks a parentUuid-linked chain; when the chain is broken or
 * segments are disconnected, only the reachable chain contributes to context usage.
 */
export async function countSessionTokens(session: ClaudeSession): Promise<number> {
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  const chainMessages = getChainMessages(entries);

  const tokenizer = getTokenizer();
  try {
    let tokens = 0;
    for (const entry of chainMessages) {
      tokens += countTokensForClaudeMessage(entry, tokenizer);
    }
    return tokens;
  } finally {
    tokenizer.free();
  }
}

function safeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function ensureTrailingNewline(text: string): string {
  if (text.length === 0) return "";
  if (text.endsWith("\n")) return text;
  return text + "\n";
}

export async function planClaudeRemovalByTokens(params: {
  visibleMessages: readonly ClaudeEntryLine[];
  amount: TokensOrPercent;
  keepLastMessages?: number;
  countTokensFn?: (text: string) => Promise<number>;
}): Promise<TokenRemovalPlan> {
  const countFn = params.countTokensFn ?? countTokens;
  const tokensPerMessage: number[] = [];

  for (const entry of params.visibleMessages) {
    const entryType = asString(entry.value.type);
    if (entryType !== "user" && entryType !== "assistant") {
      tokensPerMessage.push(0);
      continue;
    }

    const message = entry.value.message;
    if (typeof message !== "object" || message === null) {
      tokensPerMessage.push(0);
      continue;
    }
    const msgObj = message as Record<string, unknown>;
    const content = msgObj.content;

    let messageTokens = 0;
    if (typeof content === "string") {
      const s = ensureTrailingNewline(content);
      messageTokens += s.length === 0 ? 0 : await countFn(s);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        const t = asString(b.type);
        if (t === "text") {
          const text = asString(b.text);
          if (!text) continue;
          const s = ensureTrailingNewline(text);
          messageTokens += s.length === 0 ? 0 : await countFn(s);
        } else if (t === "tool_use") {
          const name = asString(b.name);
          if (!name) continue;
          messageTokens += await countFn(`[tool: ${name}]\n`);
          if ("input" in b) messageTokens += await countFn(JSON.stringify(b.input) + "\n");
        } else if (t === "tool_result") {
          for (const segment of getToolResultTokenSegments(b.content)) {
            messageTokens += await countFn(segment);
          }
        }
      }
    }

    tokensPerMessage.push(safeNonNegativeInt(messageTokens));
  }

  return planPrefixRemovalByTokens({
    tokensPerMessage,
    amount: params.amount,
    ...(params.keepLastMessages !== undefined ? { keepLastMessages: params.keepLastMessages } : {}),
  });
}

/**
 * Get message type distribution in session
 */
export function getMessageTypes(session: ClaudeSession): Record<string, number> {
  const types: Record<string, number> = {};

  for (const line of session.lines) {
    if (line.kind !== "entry") continue;

    const entry = line as ClaudeEntryLine;
    const type = asString(entry.value.type);

    if (type && type !== "file-history-snapshot") {
      types[type] = (types[type] ?? 0) + 1;
    }
  }

  return types;
}

/**
 * Count visible messages in the visible segment (after the last compact boundary).
 */
export function countVisibleMessages(session: ClaudeSession): number {
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
  return getChainMessages(entries).length;
}

/**
 * Count tokens for Claude Code "Messages" in the visible segment.
 */
export async function countClaudeMessagesTokens(session: ClaudeSession): Promise<number> {
  return countSessionTokens(session);
}
