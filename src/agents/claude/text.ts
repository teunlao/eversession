import { asString } from "../../core/json.js";
import { getContentBlocks, getMessage } from "./model.js";
import type { ClaudeEntryLine } from "./session.js";

export function getClaudeEntryText(entry: ClaudeEntryLine): string {
  const message = getMessage(entry);
  if (message) {
    const raw = message.content;
    if (typeof raw === "string") return raw;
  }

  const parts: string[] = [];
  for (const block of getContentBlocks(entry)) {
    if (asString(block.type) !== "text") continue;
    const text = asString(block.text);
    if (text) parts.push(text);
  }
  return parts.join(" ");
}
