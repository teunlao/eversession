import { asString, isJsonObject } from "../../core/json.js";
import { expandHome } from "../../core/paths.js";

export type ClaudeHookInput = {
  raw: unknown;
  hookEventName?: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
};

export async function readClaudeHookInputIfAny(timeoutMs: number): Promise<ClaudeHookInput | undefined> {
  const raw = await readJsonFromStdinIfAny(timeoutMs);
  if (!raw) return undefined;

  const hookEventName = extractString(raw, ["hook_event_name", "hookEventName", "event"]);
  const sessionId = extractString(raw, ["session_id", "sessionId", "conversation_id", "conversationId"]);
  const transcriptPathRaw = extractString(raw, ["transcript_path", "transcriptPath"]);
  const cwdRaw = extractString(raw, ["cwd"]);

  return {
    raw,
    ...(hookEventName ? { hookEventName } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPathRaw ? { transcriptPath: expandHome(transcriptPathRaw) } : {}),
    ...(cwdRaw ? { cwd: expandHome(cwdRaw) } : {}),
  };
}

async function readJsonFromStdinIfAny(timeoutMs: number): Promise<unknown | undefined> {
  if (process.stdin.isTTY) return undefined;

  const text = await new Promise<string | undefined>((resolve) => {
    let finished = false;
    let gotData = false;
    const chunks: string[] = [];
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: string | undefined): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      resolve(value);
    };

    const onData = (chunk: string): void => {
      gotData = true;
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(chunks.join(""));
    const onError = (): void => finish(undefined);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);

    timer = setTimeout(() => {
      if (!gotData) {
        process.stdin.pause();
        finish(undefined);
      }
    }, timeoutMs);
  });

  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function extractString(payload: unknown, keys: string[]): string | undefined {
  const candidates = candidateObjects(payload);
  for (const obj of candidates) {
    for (const key of keys) {
      const direct = asString(obj[key]);
      if (direct && direct.trim().length > 0) return direct;
    }
  }
  return undefined;
}

function candidateObjects(payload: unknown): Array<Record<string, unknown>> {
  if (!isJsonObject(payload)) return [];
  const out: Array<Record<string, unknown>> = [payload];
  const nested = payload.payload;
  if (isJsonObject(nested)) out.push(nested);
  return out;
}
