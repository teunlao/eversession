import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { countBySeverity, type Issue } from "../../core/issues.js";
import { asString, isJsonObject } from "../../core/json.js";
import { detectSession } from "../detect.js";
import {
  listFiles,
  matchInTailRaw,
  maxTimestampIso,
  normalizeCwdCandidates,
  readJsonlHead,
  readJsonlTail,
} from "../session-discovery/shared.js";
import type {
  SessionAlternative,
  SessionConfidence,
  SessionDiscoveryMethod,
  SessionDiscoveryReport,
  SessionHit,
} from "../session-discovery/types.js";
import { parseCodexSession } from "./session.js";
import { validateCodexSession } from "./validate.js";

export type DiscoverCodexOptions = {
  cwd: string;
  codexSessionsDir: string;
  sessionId?: string;
  match?: string;
  fallback: boolean;
  lookbackDays: number;
  maxCandidates: number;
  tailLines: number;
  validate: boolean;
};

function scoreToConfidence(score: number, method: SessionDiscoveryMethod): SessionConfidence {
  if (method === "session-id") return "high";
  if (method === "fallback") return "low";
  if (score >= 140) return "high";
  if (score >= 80) return "medium";
  return "low";
}

function formatYyyyMmDd(date: Date): { yyyy: string; mm: string; dd: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return { yyyy: String(date.getFullYear()), mm: pad(date.getMonth() + 1), dd: pad(date.getDate()) };
}

async function validateHealth(
  filePath: string,
): Promise<{ health: { parseErrors: number; validationErrors: number; validationWarnings: number } }> {
  const parsed = await parseCodexSession(filePath);
  const vIssues = parsed.session ? validateCodexSession(parsed.session) : [];
  const parseCounts = countBySeverity(parsed.issues);
  const vCounts = countBySeverity(vIssues);
  return {
    health: { parseErrors: parseCounts.error, validationErrors: vCounts.error, validationWarnings: vCounts.warning },
  };
}

function unknownReport(cwd: string, message: string): SessionDiscoveryReport {
  const issues: Issue[] = [
    {
      severity: "error",
      code: "codex.session_not_found",
      message,
      location: { kind: "file", path: cwd },
    },
  ];
  return { agent: "unknown", cwd, issues, alternatives: [] };
}

export async function discoverCodexSession(opts: DiscoverCodexOptions): Promise<SessionDiscoveryReport> {
  const cwdCandidates = await normalizeCwdCandidates(opts.cwd);
  const targetCwds = new Set(cwdCandidates);

  const listRolloutCandidates = async (): Promise<Array<{ filePath: string; mtimeMs: number; mtimeIso: string }>> => {
    const now = new Date();
    const out: Array<{ filePath: string; mtimeMs: number; mtimeIso: string }> = [];

    for (let i = 0; i < opts.lookbackDays; i += 1) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const { yyyy, mm, dd } = formatYyyyMmDd(d);
      const dayDir = path.join(opts.codexSessionsDir, yyyy, mm, dd);
      const entries = await listFiles(dayDir);
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
        out.push({ filePath, mtimeMs: st.mtimeMs, mtimeIso: st.mtime.toISOString() });
      }
    }

    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, opts.maxCandidates);
  };

  const candidates = await listRolloutCandidates();
  if (candidates.length === 0) {
    return unknownReport(opts.cwd, "[Codex] No rollout sessions found in lookback window.");
  }

  const findSessionMeta = async (
    filePath: string,
  ): Promise<{ id?: string; cwd?: string; hasSessionMeta: boolean; invalidJsonHead: number }> => {
    const { jsonObjects, invalidJsonLines } = await readJsonlHead(filePath, 100);
    for (const obj of jsonObjects) {
      const type = asString(obj.type);
      if (type !== "session_meta") continue;
      if (!isJsonObject(obj.payload)) return { hasSessionMeta: true, invalidJsonHead: invalidJsonLines };
      const id = asString(obj.payload.id);
      const cwd = asString(obj.payload.cwd);
      const out: { id?: string; cwd?: string; hasSessionMeta: boolean; invalidJsonHead: number } = {
        hasSessionMeta: true,
        invalidJsonHead: invalidJsonLines,
      };
      if (id) out.id = id;
      if (cwd) out.cwd = cwd;
      return out;
    }
    return { hasSessionMeta: false, invalidJsonHead: invalidJsonLines };
  };

  // Strategy 1: --session-id
  if (opts.sessionId) {
    const wanted = opts.sessionId;
    const matches = candidates.filter((c) => c.filePath.includes(`-${wanted}.jsonl`));
    for (const m of matches) {
      const meta = await findSessionMeta(m.filePath);
      if (!meta.hasSessionMeta) continue;
      const score = 100 + (meta.invalidJsonHead > 0 ? -50 : 0);
      const confidence = scoreToConfidence(score, "session-id");

      const session: SessionHit = {
        path: m.filePath,
        id: wanted,
        agent: "codex",
        method: "session-id",
        confidence,
        score,
        cwd: opts.cwd,
        mtime: m.mtimeIso,
      };
      if (opts.validate) session.health = (await validateHealth(m.filePath)).health;

      return { agent: "codex", cwd: opts.cwd, method: "session-id", confidence, session, alternatives: [] };
    }
    if (!opts.fallback) return unknownReport(opts.cwd, `[Codex] session-id not found in lookback window: ${wanted}`);
  }

  // Strategy 2: --match
  if (opts.match && opts.match.trim().length > 0) {
    const needle = opts.match.trim();
    const hits: Array<{ filePath: string; score: number; mtimeMs: number; mtimeIso: string; reason: string }> = [];
    for (const c of candidates) {
      const { tail } = await readJsonlTail(c.filePath, opts.tailLines);
      if (!matchInTailRaw(tail, needle)) continue;
      hits.push({
        filePath: c.filePath,
        score: 10,
        mtimeMs: c.mtimeMs,
        mtimeIso: c.mtimeIso,
        reason: "Tail JSONL contains match text.",
      });
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const best = hits[0];
    if (!best) return unknownReport(opts.cwd, "[Codex] No session matched the provided --match text.");

    const confidence = scoreToConfidence(best.score, "match");
    const session: SessionHit = {
      path: best.filePath,
      agent: "codex",
      method: "match",
      confidence,
      score: best.score,
      cwd: opts.cwd,
      mtime: best.mtimeIso,
    };
    if (opts.validate) session.health = (await validateHealth(best.filePath)).health;

    const alternatives: SessionAlternative[] = hits
      .slice(0, 5)
      .map((h) => ({ path: h.filePath, score: h.score, reason: h.reason }));
    return { agent: "codex", cwd: opts.cwd, method: "match", confidence, session, alternatives };
  }

  const ranked: Array<{
    filePath: string;
    id?: string;
    cwd?: string;
    score: number;
    mtimeMs: number;
    mtimeIso: string;
    lastActivity?: string;
    lastActivityMs: number;
    method: SessionDiscoveryMethod;
    reason: string;
  }> = [];

  for (const c of candidates) {
    const meta = await findSessionMeta(c.filePath);
    const { tail, invalidJsonLines } = await readJsonlTail(c.filePath, opts.tailLines);
    const tailJson = tail.filter((t): t is { kind: "json"; line: number; value: unknown } => t.kind === "json");
    const lastActivity = maxTimestampIso(tailJson.map((t) => t.value));
    const lastActivityMs = lastActivity ? Date.parse(lastActivity) : 0;

    let score = 0;
    if (meta.hasSessionMeta) score += 50;
    if (meta.id) score += 10;

    let method: SessionDiscoveryMethod = "fallback";
    let reason = "Selected via lookback fallback (no cwd match).";
    if (meta.cwd && targetCwds.has(meta.cwd)) {
      score += 100;
      method = "cwd-hash";
      reason = "Matched session_meta.payload.cwd to target CWD.";
    } else if (meta.cwd) {
      score -= 10;
    }

    if (meta.invalidJsonHead + invalidJsonLines > 0) score -= 50;

    const detected = await detectSession(c.filePath);
    if (detected.agent === "codex") score += 20;
    else score -= 100;

    const item: {
      filePath: string;
      id?: string;
      cwd?: string;
      score: number;
      mtimeMs: number;
      mtimeIso: string;
      lastActivity?: string;
      lastActivityMs: number;
      method: SessionDiscoveryMethod;
      reason: string;
    } = {
      filePath: c.filePath,
      score,
      mtimeMs: c.mtimeMs,
      mtimeIso: c.mtimeIso,
      lastActivityMs,
      method,
      reason,
    };
    if (meta.id) item.id = meta.id;
    if (meta.cwd) item.cwd = meta.cwd;
    if (lastActivity) item.lastActivity = lastActivity;
    ranked.push(item);
  }

  const preferred = ranked.some((r) => r.method !== "fallback") ? ranked.filter((r) => r.method !== "fallback") : ranked;

  preferred.sort((a, b) => {
    if (b.lastActivityMs !== a.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });

  const best = preferred[0];
  if (!best) return unknownReport(opts.cwd, "[Codex] Failed to rank any candidates.");
  if (!opts.fallback && best.method === "fallback")
    return unknownReport(opts.cwd, "[Codex] No rollout matched target CWD and fallback is disabled.");

  const confidence = scoreToConfidence(best.score, best.method);
  const session: SessionHit = {
    path: best.filePath,
    agent: "codex",
    method: best.method,
    confidence,
    score: best.score,
    cwd: opts.cwd,
    mtime: best.mtimeIso,
  };
  if (best.id) session.id = best.id;
  if (best.lastActivity) session.lastActivity = best.lastActivity;
  if (opts.validate) session.health = (await validateHealth(best.filePath)).health;

  const alternatives: SessionAlternative[] = preferred
    .slice(0, 5)
    .map((r) => ({ path: r.filePath, score: r.score, reason: r.reason }));
  return { agent: "codex", cwd: opts.cwd, method: best.method, confidence, session, alternatives };
}
