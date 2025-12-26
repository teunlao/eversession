import * as fs from "node:fs/promises";

import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import { detectSession } from "eversession/agents/detect.js";
import { maxTimestampIso, readJsonlTail } from "eversession/agents/session-discovery/shared.js";
import { fileExists } from "eversession/core/fs.js";
import { getLogPath, getSessionDir, getStatePath, readSessionState } from "eversession/integrations/claude/eversession-session-storage.js";

type ApiJsonlTailItem =
  | { kind: "json"; line: number; value: unknown }
  | { kind: "invalid_json"; line: number; error: string };

type ApiSessionDetail = {
  path: string;
  id?: string;
  agent: "claude" | "codex" | "unknown";
  confidence?: string;
  mtimeMs: number;
  mtime: string;
  sizeBytes: number;
  lastActivity?: string;
  tail: {
    tail: ApiJsonlTailItem[];
    invalidJsonLines: number;
  };
  evs?: {
    tracked: boolean;
    sessionDir?: string;
    logPath?: string;
    statePath?: string;
    state?: unknown;
    logTail?: {
      tail: ApiJsonlTailItem[];
      invalidJsonLines: number;
    };
  };
};

function parsePositiveInt(value: string | null, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export const GET: RequestHandler = async ({ url }) => {
  const transcriptPath = url.searchParams.get("path")?.trim();
  if (!transcriptPath) return json({ error: "Missing required query param: path" }, { status: 400 });

  if (!(await fileExists(transcriptPath))) return json({ error: "Session file not found" }, { status: 404 });

  const st = await fs.stat(transcriptPath);
  const tailLines = parsePositiveInt(url.searchParams.get("tailLines"), 160);
  const logLines = parsePositiveInt(url.searchParams.get("logLines"), 160);
  const sessionId = url.searchParams.get("id")?.trim() || undefined;

  const detected = await detectSession(transcriptPath).catch(() => ({ agent: "unknown" as const, confidence: "low" as const }));

  const transcriptTail = await readJsonlTail(transcriptPath, Math.min(tailLines, 400));
  const lastActivity = maxTimestampIso(
    transcriptTail.tail
      .filter((t): t is { kind: "json"; line: number; value: unknown } => t.kind === "json")
      .map((t) => t.value),
  );

  const detail: ApiSessionDetail = {
    path: transcriptPath,
    ...(sessionId ? { id: sessionId } : {}),
    agent: detected.agent,
    ...(detected.confidence ? { confidence: detected.confidence } : {}),
    mtimeMs: st.mtimeMs,
    mtime: st.mtime.toISOString(),
    sizeBytes: st.size,
    ...(lastActivity ? { lastActivity } : {}),
    tail: {
      tail: transcriptTail.tail satisfies ApiJsonlTailItem[],
      invalidJsonLines: transcriptTail.invalidJsonLines,
    },
  };

  if (!sessionId) return json(detail);

  const sessionDir = getSessionDir(sessionId);
  const tracked = await fileExists(sessionDir);
  if (!tracked) return json(detail);

  const logPath = getLogPath(sessionId);
  const statePath = getStatePath(sessionId);
  const [state, logTail] = await Promise.all([
    readSessionState(sessionId).catch(() => undefined),
    fileExists(logPath)
      ? readJsonlTail(logPath, Math.min(logLines, 400)).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  detail.evs = {
    tracked: true,
    sessionDir,
    ...(await fileExists(logPath) ? { logPath } : {}),
    ...(await fileExists(statePath) ? { statePath } : {}),
    ...(state ? { state } : {}),
    ...(logTail ? { logTail: { tail: logTail.tail satisfies ApiJsonlTailItem[], invalidJsonLines: logTail.invalidJsonLines } } : {}),
  };

  return json(detail);
};

