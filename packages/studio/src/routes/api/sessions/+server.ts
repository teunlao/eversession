import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import { normalizeCwdCandidates, readJsonlHead } from "eversession/agents/session-discovery/shared.js";
import { fileExists } from "eversession/core/fs.js";
import { asString, isJsonObject } from "eversession/core/json.js";
import { getLogPath, getSessionDir, getSessionLastActivityMs, getStatePath, readSessionState } from "eversession/integrations/claude/eversession-session-storage.js";
import { defaultClaudeProjectsDir } from "eversession/integrations/claude/paths.js";
import { defaultCodexSessionsDir } from "eversession/integrations/codex/paths.js";

type ApiSessionAgent = "claude" | "codex";

type ApiEvsSessionInfo = {
  tracked: boolean;
  sessionDir?: string;
  logPath?: string;
  statePath?: string;
  lastActivityMs?: number;
  lastActivity?: string;
  state?: unknown;
};

type ApiSession = {
  agent: ApiSessionAgent;
  id: string;
  path: string;
  mtimeMs: number;
  mtime: string;
  cwd?: string;
  source: "claude-project" | "codex-rollout";
  evs: ApiEvsSessionInfo;
};

function parsePositiveInt(value: string | null, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function cwdHashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

function cwdHashV1(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

async function listClaudeProjectSessions(params: {
  cwd: string;
  maxSessions: number;
  includeSidechains: boolean;
}): Promise<ApiSession[]> {
  const baseDir = defaultClaudeProjectsDir();
  const cwdCandidates = await normalizeCwdCandidates(params.cwd);
  const seen = new Set<string>();
  const out: ApiSession[] = [];

  for (const cwd of cwdCandidates) {
    const hashes = [cwdHashV2(cwd), cwdHashV1(cwd)];
    for (const h of hashes) {
      const projectDir = path.join(baseDir, h);
      if (seen.has(projectDir)) continue;
      seen.add(projectDir);

      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await fs.readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!e.name.endsWith(".jsonl")) continue;
        if (!params.includeSidechains && e.name.startsWith("agent-")) continue;

        const filePath = path.join(projectDir, e.name);
        let st: { mtimeMs: number; mtime: Date };
        try {
          const stat = await fs.stat(filePath);
          st = { mtimeMs: stat.mtimeMs, mtime: stat.mtime };
        } catch {
          continue;
        }

        const id = e.name.slice(0, -".jsonl".length);
        out.push({
          agent: "claude",
          id,
          path: filePath,
          mtimeMs: st.mtimeMs,
          mtime: st.mtime.toISOString(),
          source: "claude-project",
          evs: { tracked: false },
        });
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, params.maxSessions);
}

function formatYyyyMmDd(date: Date): { yyyy: string; mm: string; dd: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return { yyyy: String(date.getFullYear()), mm: pad(date.getMonth() + 1), dd: pad(date.getDate()) };
}

async function listCodexRolloutCandidates(params: {
  codexSessionsDir: string;
  lookbackDays: number;
  maxCandidates: number;
}): Promise<Array<{ filePath: string; mtimeMs: number; mtime: string }>> {
  const now = new Date();
  const out: Array<{ filePath: string; mtimeMs: number; mtime: string }> = [];

  for (let i = 0; i < params.lookbackDays; i += 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const { yyyy, mm, dd } = formatYyyyMmDd(d);
    const dayDir = path.join(params.codexSessionsDir, yyyy, mm, dd);

    let entries: Array<{ name: string; isFile(): boolean }>;
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
      try {
        const stat = await fs.stat(filePath);
        out.push({ filePath, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() });
      } catch {
        // ignore
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, params.maxCandidates);
}

async function readCodexSessionMeta(filePath: string): Promise<{ id?: string; cwd?: string }> {
  try {
    const { jsonObjects } = await readJsonlHead(filePath, 200);
    for (const obj of jsonObjects) {
      if (asString(obj.type) !== "session_meta") continue;
      const payload = obj.payload;
      if (!isJsonObject(payload)) continue;
      const id = asString(payload.id);
      const cwd = asString(payload.cwd);
      const out: { id?: string; cwd?: string } = {};
      if (id) out.id = id;
      if (cwd) out.cwd = cwd;
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

async function listCodexSessionsForCwd(params: {
  cwd: string;
  lookbackDays: number;
  maxCandidates: number;
  maxSessions: number;
}): Promise<ApiSession[]> {
  const baseDir = defaultCodexSessionsDir();
  const cwdCandidates = await normalizeCwdCandidates(params.cwd);
  const targetCwds = new Set(cwdCandidates);

  const candidates = await listCodexRolloutCandidates({
    codexSessionsDir: baseDir,
    lookbackDays: params.lookbackDays,
    maxCandidates: params.maxCandidates,
  });

  const out: ApiSession[] = [];

  for (const c of candidates) {
    const meta = await readCodexSessionMeta(c.filePath);
    if (!meta.id || !meta.cwd) continue;
    if (!targetCwds.has(meta.cwd)) continue;

    out.push({
      agent: "codex",
      id: meta.id,
      path: c.filePath,
      cwd: meta.cwd,
      mtimeMs: c.mtimeMs,
      mtime: c.mtime,
      source: "codex-rollout",
      evs: { tracked: false },
    });
  }

  // Deduplicate by session id (keep newest rollout file).
  const byId = new Map<string, ApiSession>();
  for (const s of out) {
    const existing = byId.get(s.id);
    if (!existing || s.mtimeMs > existing.mtimeMs) byId.set(s.id, s);
  }

  const unique = [...byId.values()];
  unique.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unique.slice(0, params.maxSessions);
}

async function enrichWithEvs(session: ApiSession): Promise<ApiSession> {
  const sessionDir = getSessionDir(session.id);
  const tracked = await fileExists(sessionDir);

  if (!tracked) return session;

  const logPath = getLogPath(session.id);
  const statePath = getStatePath(session.id);

  const lastActivityMs = await getSessionLastActivityMs(session.id);
  const state = await readSessionState(session.id);

  return {
    ...session,
    evs: {
      tracked: true,
      sessionDir,
      ...(await fileExists(logPath) ? { logPath } : {}),
      ...(await fileExists(statePath) ? { statePath } : {}),
      ...(lastActivityMs ? { lastActivityMs, lastActivity: new Date(lastActivityMs).toISOString() } : {}),
      ...(state ? { state } : {}),
    },
  };
}

export const GET: RequestHandler = async ({ url }) => {
  const cwd = url.searchParams.get("cwd")?.trim() || process.cwd();
  const includeSidechains = url.searchParams.get("includeSidechains") === "1";
  const limit = parsePositiveInt(url.searchParams.get("limit"), 80);
  const lookbackDays = parsePositiveInt(url.searchParams.get("lookbackDays"), 14);

  const claude = await listClaudeProjectSessions({ cwd, maxSessions: limit, includeSidechains });
  const codex = await listCodexSessionsForCwd({
    cwd,
    lookbackDays,
    maxCandidates: Math.max(limit * 5, 200),
    maxSessions: limit,
  });

  const merged = [...claude, ...codex];

  // Enrich with EVS state/logs presence (best-effort).
  const enriched: ApiSession[] = [];
  for (const s of merged) {
    enriched.push(await enrichWithEvs(s).catch(() => s));
  }

  // Sort by EVS last activity if available, otherwise transcript mtime.
  enriched.sort((a, b) => {
    const aMs = a.evs.lastActivityMs ?? a.mtimeMs;
    const bMs = b.evs.lastActivityMs ?? b.mtimeMs;
    return bMs - aMs;
  });

  return json({ cwd, sessions: enriched.slice(0, limit) });
};

