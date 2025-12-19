import { asString } from "../../core/json.js";
import type { ClaudeEntryLine } from "./session.js";

export function tombstoneClaudeEntryMessage(entry: ClaudeEntryLine, note: string): void {
  const message = entry.value.message;
  if (typeof message !== "object" || message === null) return;

  const msgObj = message as Record<string, unknown>;
  const role = asString(msgObj.role);

  if (role === "assistant") {
    msgObj.content = [{ type: "text", text: note }];
    return;
  }

  msgObj.content = note;
}

