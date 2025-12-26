import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type DiscoverCodexOptions, discoverCodexSession } from "../../agents/codex/discover.js";
import { normalizeCwdCandidates, readJsonlHead } from "../../agents/session-discovery/shared.js";
import type { SessionDiscoveryReport } from "../../agents/session-discovery/types.js";
import { asString, isJsonObject } from "../../core/json.js";
import { resolveCodexStatePath, resolveCodexThreadIdForCwd, updateCodexStateFromNotify } from "./state.js";

export type CodexDiscoveryOptions = DiscoverCodexOptions;

function formatYyyyMmDd(date: Date): { yyyy: string; mm: string; dd: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return { yyyy: String(date.getFullYear()), mm: pad(date.getMonth() + 1), dd: pad(date.getDate()) };
}

async function listRolloutCandidates(opts: {
  codexSessionsDir: string;
  lookbackDays: number;
  maxCandidates: number;
}): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const now = new Date();
  const out: Array<{ filePath: string; mtimeMs: number }> = [];

  for (let i = 0; i < opts.lookbackDays; i += 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const { yyyy, mm, dd } = formatYyyyMmDd(d);
    const dayDir = path.join(opts.codexSessionsDir, yyyy, mm, dd);
    let entries: Array<{ isFile(): boolean; name: string }>;
    try {
      entries = await fs.readdir(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.startsWith("rollout-")) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dayDir, e.name);
      let st: Stats;
      try {
        st = await fs.stat(filePath);
      } catch {
        continue;
      }
      out.push({ filePath, mtimeMs: st.mtimeMs });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
  return out.slice(0, opts.maxCandidates);
}

async function readCodexSessionMeta(filePath: string): Promise<{ id?: string; cwd?: string; timestampMs?: number }> {
  try {
    const { jsonObjects } = await readJsonlHead(filePath, 200);
    for (const obj of jsonObjects) {
      if (asString(obj.type) !== "session_meta") continue;
      const payload = obj.payload;
      if (!isJsonObject(payload)) continue;
      const id = asString(payload.id);
      const cwd = asString(payload.cwd);
      const timestamp = asString(payload.timestamp);
      const tsMs = timestamp ? Date.parse(timestamp) : NaN;
      const out: { id?: string; cwd?: string; timestampMs?: number } = {};
      if (id) out.id = id;
      if (cwd) out.cwd = cwd;
      if (Number.isFinite(tsMs) && tsMs > 0) out.timestampMs = tsMs;
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

async function findNewerCwdMatchingThreadId(opts: {
  cwd: string;
  codexSessionsDir: string;
  lookbackDays: number;
  maxCandidates: number;
  newerThanMs: number;
  excludeThreadId: string;
}): Promise<string | undefined> {
  const targetCwds = new Set(await normalizeCwdCandidates(opts.cwd));
  const candidates = await listRolloutCandidates({
    codexSessionsDir: opts.codexSessionsDir,
    lookbackDays: opts.lookbackDays,
    maxCandidates: opts.maxCandidates,
  });

  const baseMs = Number.isFinite(opts.newerThanMs) ? opts.newerThanMs : 0;
  let best: { id: string; freshnessMs: number } | undefined;

  for (const c of candidates) {
    const meta = await readCodexSessionMeta(c.filePath);
    if (!meta.id || meta.id === opts.excludeThreadId) continue;
    if (!meta.cwd || !targetCwds.has(meta.cwd)) continue;

    const freshnessMs = meta.timestampMs ?? c.mtimeMs;
    if (baseMs > 0 && freshnessMs <= baseMs) continue;
    if (!best || freshnessMs > best.freshnessMs || (freshnessMs === best.freshnessMs && meta.id > best.id)) {
      best = { id: meta.id, freshnessMs };
    }
  }

  return best?.id;
}

export async function discoverCodexSessionReport(opts: CodexDiscoveryOptions): Promise<SessionDiscoveryReport> {
  if (!opts.sessionId && !opts.match) {
    const statePath = resolveCodexStatePath();
    try {
      const threadId = await resolveCodexThreadIdForCwd({ cwd: opts.cwd, statePath });
      if (threadId) {
        const fromState = await discoverCodexSession({ ...opts, sessionId: threadId });
        if (fromState.agent === "codex") {
          const stateMeta = await readCodexSessionMeta(fromState.session.path);
          const mtimeMs = Date.parse(fromState.session.mtime ?? "");
          const stateMtimeMs = stateMeta.timestampMs ?? (Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0);
          const newerId = await findNewerCwdMatchingThreadId({
            cwd: opts.cwd,
            codexSessionsDir: opts.codexSessionsDir,
            lookbackDays: opts.lookbackDays,
            maxCandidates: opts.maxCandidates,
            newerThanMs: stateMtimeMs,
            excludeThreadId: threadId,
          });
          if (newerId) {
            const fromNewer = await discoverCodexSession({ ...opts, sessionId: newerId });
            if (fromNewer.agent === "codex") {
              try {
                await updateCodexStateFromNotify({
                  statePath,
                  event: { type: "agent-turn-complete", "thread-id": newerId, cwd: opts.cwd },
                });
              } catch {
                // Ignore state write failures; discovery still succeeds.
              }
              return fromNewer;
            }
          }

          return fromState;
        }
        if (fromState.agent !== "unknown") return fromState;
      }
    } catch {
      // Ignore state file issues: discovery fallback still works.
    }
  }

  return discoverCodexSession(opts);
}
