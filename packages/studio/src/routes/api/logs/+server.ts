import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import { readJsonlTail } from "eversession/agents/session-discovery/shared.js";
import { fileExists } from "eversession/core/fs.js";
import { getLogPath, getSessionDir } from "eversession/integrations/claude/eversession-session-storage.js";

type ApiJsonlTailItem =
  | { kind: "json"; line: number; value: unknown }
  | { kind: "invalid_json"; line: number; error: string };

function parsePositiveInt(value: string | null, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export const GET: RequestHandler = async ({ url }) => {
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) return json({ error: "Missing required query param: sessionId" }, { status: 400 });

  const sessionDir = getSessionDir(sessionId);
  if (!(await fileExists(sessionDir))) return json({ error: "EVS session not found" }, { status: 404 });

  const tailLines = parsePositiveInt(url.searchParams.get("tailLines"), 200);
  const logPath = getLogPath(sessionId);
  if (!(await fileExists(logPath))) return json({ sessionId, logPath, tail: [], invalidJsonLines: 0 });

  const tail = await readJsonlTail(logPath, Math.min(tailLines, 400));

  return json({
    sessionId,
    logPath,
    tail: tail.tail satisfies ApiJsonlTailItem[],
    invalidJsonLines: tail.invalidJsonLines,
  });
};

