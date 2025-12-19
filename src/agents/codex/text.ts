import { asString, isJsonObject } from "../../core/json.js";

export function getCodexMessageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isJsonObject(item)) continue;
    const t = asString(item.type);
    if (t !== "input_text" && t !== "output_text") continue;
    const text = asString(item.text);
    if (text) parts.push(text);
  }
  return parts.join("");
}

export function getCodexReasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = [];

  const summary = payload.summary;
  if (Array.isArray(summary)) {
    for (const item of summary) {
      if (!isJsonObject(item)) continue;
      if (asString(item.type) !== "summary_text") continue;
      const text = asString(item.text);
      if (text) parts.push(text);
    }
  }

  const content = payload.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isJsonObject(item)) continue;
      const t = asString(item.type);
      if (t !== "reasoning_text" && t !== "text") continue;
      const text = asString(item.text);
      if (text) parts.push(text);
    }
  }

  return parts.join("\n");
}

