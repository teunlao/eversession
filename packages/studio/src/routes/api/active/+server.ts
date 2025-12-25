import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import {
  isPidAlive,
  listActiveRunRecordPaths,
  readActiveRunRecordFile,
  type EvsActiveRunAgent,
  type EvsActiveRunRecord,
} from "eversession";
import { readSupervisorHandshake as readClaudeHandshake } from "eversession/integrations/claude/supervisor-control.js";
import { readSupervisorHandshake as readCodexHandshake } from "eversession/integrations/codex/supervisor-control.js";

type ApiHandshake =
  | { agent: "claude"; ts: string; sessionId: string; transcriptPath: string }
  | { agent: "codex"; ts: string; threadId: string; cwd: string; turnId?: string };

type ApiActiveRun = {
  agent: EvsActiveRunAgent;
  runId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  reloadMode: EvsActiveRunRecord["reloadMode"];
  alive: boolean;
  handshake?: ApiHandshake;
};

async function enrichHandshake(record: EvsActiveRunRecord): Promise<ApiHandshake | undefined> {
  if (record.agent === "claude") {
    const hs = await readClaudeHandshake(record.controlDir);
    if (!hs || hs.runId !== record.runId) return undefined;
    return { agent: "claude", ts: hs.ts, sessionId: hs.sessionId, transcriptPath: hs.transcriptPath };
  }

  const hs = await readCodexHandshake(record.controlDir);
  if (!hs || hs.runId !== record.runId) return undefined;
  return { agent: "codex", ts: hs.ts, threadId: hs.threadId, cwd: hs.cwd, ...(hs.turnId ? { turnId: hs.turnId } : {}) };
}

export const GET: RequestHandler = async () => {
  const recordPaths = await listActiveRunRecordPaths();
  const out: ApiActiveRun[] = [];

  for (const recordPath of recordPaths) {
    const record = await readActiveRunRecordFile(recordPath);
    if (!record) continue;

    const alive = isPidAlive(record.pid);
    const handshake = await enrichHandshake(record).catch(() => undefined);

    out.push({
      agent: record.agent,
      runId: record.runId,
      pid: record.pid,
      cwd: record.cwd,
      startedAt: record.startedAt,
      reloadMode: record.reloadMode,
      alive,
      ...(handshake ? { handshake } : {}),
    });
  }

  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return json({ runs: out });
};
