import * as fs from "node:fs/promises";
import * as path from "node:path";

import { detectSession } from "../detect.js";
import { countBySeverity, type Issue } from "../../core/issues.js";
import { parseClaudeSession } from "./session.js";
import { validateClaudeSession } from "./validate.js";
import type { SessionDiscoveryReport, SessionHit, SessionAlternative, SessionConfidence, SessionDiscoveryMethod } from "../session-discovery/types.js";
import { listFiles, matchInTailRaw, maxTimestampIso, normalizeCwdCandidates, readJsonlHead, readJsonlTail } from "../session-discovery/shared.js";
import { asString, isJsonObject } from "../../core/json.js";
import { fileExists } from "../../core/fs.js";
import { isStrictFallbackAllowed } from "../session-discovery/strict.js";

export type DiscoverClaudeOptions = {
  cwd: string;
  claudeProjectsDir: string;
  sessionId?: string;
  match?: string;
  fallback: boolean;
  maxCandidates: number;
  tailLines: number;
  includeSidechains: boolean;
  validate: boolean;
};

function cwdHashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

function cwdHashV1(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function scoreToConfidence(score: number, method: SessionDiscoveryMethod): SessionConfidence {
  if (method === "session-id") return "high";
  if (method === "fallback") return "low";
  if (score >= 140) return "high";
  if (score >= 80) return "medium";
  return "low";
}

async function listClaudeSidechains(projectDir: string): Promise<string[]> {
  const entries = await listFiles(projectDir);
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name))
    .sort();
}

async function validateHealth(filePath: string): Promise<{ health: { parseErrors: number; validationErrors: number; validationWarnings: number } }> {
  const parsed = await parseClaudeSession(filePath);
  const vIssues = parsed.session ? validateClaudeSession(parsed.session) : [];
  const parseCounts = countBySeverity(parsed.issues);
  const vCounts = countBySeverity(vIssues);
  return { health: { parseErrors: parseCounts.error, validationErrors: vCounts.error, validationWarnings: vCounts.warning } };
}

function unknownReport(cwd: string, message: string): SessionDiscoveryReport {
  const issues: Issue[] = [
    {
      severity: "error",
      code: "claude.session_not_found",
      message,
      location: { kind: "file", path: cwd },
    },
  ];
  return { agent: "unknown", cwd, issues, alternatives: [] };
}

export async function discoverClaudeSession(opts: DiscoverClaudeOptions): Promise<SessionDiscoveryReport> {
  const cwdCandidates = await normalizeCwdCandidates(opts.cwd);
  const projectDirs: Array<{ dir: string; projectHash: string; dirPriority: number }> = [];
  const seen = new Set<string>();

  for (const cwd of cwdCandidates) {
    const hashes = [cwdHashV2(cwd), cwdHashV1(cwd)];
    for (const [hashIdx, h] of hashes.entries()) {
      const dir = path.join(opts.claudeProjectsDir, h);
      if (seen.has(dir)) continue;
      seen.add(dir);
      projectDirs.push({ dir, projectHash: h, dirPriority: projectDirs.length * 10 + hashIdx });
    }
  }

  const candidatesInDir = async (
    dir: string,
    projectHash: string,
    dirPriority: number,
  ): Promise<Array<{ filePath: string; id: string; projectHash: string; dirPriority: number }>> => {
    const entries = await listFiles(dir);
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .filter((name) => (opts.includeSidechains ? true : !name.startsWith("agent-")));

    const out: Array<{ filePath: string; id: string; projectHash: string; dirPriority: number }> = [];
    for (const name of files) {
      const id = name.slice(0, -".jsonl".length);
      out.push({ filePath: path.join(dir, name), id, projectHash, dirPriority });
    }
    return out;
  };

  const projectCandidates: Array<{ filePath: string; id: string; projectHash: string; dirPriority: number }> = [];
  for (const pd of projectDirs) {
    const inDir = await candidatesInDir(pd.dir, pd.projectHash, pd.dirPriority);
    projectCandidates.push(...inDir);
  }

  // Strategy 1: --session-id
  if (opts.sessionId) {
    const wanted = opts.sessionId;
    for (const pd of projectDirs) {
      const fp = path.join(pd.dir, `${wanted}.jsonl`);
      if (!(await fileExists(fp))) continue;
      const st = await fs.stat(fp);
      const head = await readJsonlHead(fp, 50);
      const { tail, invalidJsonLines } = await readJsonlTail(fp, opts.tailLines);

      // Ignore "summary-only / snapshot-only" files even if the filename matches.
      if (st.size > 0) {
        const headHasMessages = head.jsonObjects.some((o) => {
          const t = asString(o.type);
          return t === "user" || t === "assistant";
        });
        const tailHasMessages = tail.some(
          (t) => t.kind === "json" && isJsonObject(t.value) && (asString(t.value.type) === "user" || asString(t.value.type) === "assistant"),
        );
        if (!headHasMessages && !tailHasMessages) continue;
      }

      const tailJson = tail.filter((t): t is { kind: "json"; line: number; value: unknown } => t.kind === "json");
      const lastActivity = maxTimestampIso(tailJson.map((t) => t.value));
      const score = 100 + 30 + (invalidJsonLines > 0 ? -50 : 0);
      const confidence = scoreToConfidence(score, "session-id");

      const session: SessionHit = {
        path: fp,
        id: wanted,
        agent: "claude",
        method: "session-id",
        confidence,
        score,
        cwd: opts.cwd,
        projectHash: pd.projectHash,
        mtime: st.mtime.toISOString(),
      };
      if (lastActivity) session.lastActivity = lastActivity;
      if (opts.validate) session.health = (await validateHealth(fp)).health;
      if (opts.includeSidechains) session.sidechains = await listClaudeSidechains(path.dirname(fp));

      return { agent: "claude", cwd: opts.cwd, method: "session-id", confidence, session, alternatives: [] };
    }

    return unknownReport(opts.cwd, `[Claude] Session id not found (or not a conversation): ${wanted}`);
  }

  const candidates = projectCandidates;
  if (candidates.length === 0) {
    return unknownReport(opts.cwd, "[Claude] No session files found for this project (and fallback is disabled).");
  }

  // Strategy 2: --match (expensive)
  if (opts.match && opts.match.trim().length > 0) {
    const needle = opts.match.trim();
    const hits: Array<{ filePath: string; id: string; projectHash: string; score: number; lastActivity?: string; mtime: string; reason: string; dirPriority: number }> = [];

    for (const c of candidates.slice(0, opts.maxCandidates)) {
      const { tail, invalidJsonLines } = await readJsonlTail(c.filePath, opts.tailLines);
      if (!matchInTailRaw(tail, needle)) continue;
      const st = await fs.stat(c.filePath);
      if (st.size > 0) {
        const head = await readJsonlHead(c.filePath, 50);
        const headHasMessages = head.jsonObjects.some((o) => {
          const t = asString(o.type);
          return t === "user" || t === "assistant";
        });
        const tailHasMessages = tail.some((t) => t.kind === "json" && isJsonObject(t.value) && (asString(t.value.type) === "user" || asString(t.value.type) === "assistant"));
        if (!headHasMessages && !tailHasMessages) continue;
      }
      const tailJson = tail.filter((t): t is { kind: "json"; line: number; value: unknown } => t.kind === "json");
      const lastActivity = maxTimestampIso(tailJson.map((t) => t.value));

      let score = 0;
      score += c.dirPriority < 9999 ? 100 : 0;
      score += invalidJsonLines > 0 ? -50 : 0;
      score += 10;

      const hit: { filePath: string; id: string; projectHash: string; score: number; lastActivity?: string; mtime: string; reason: string; dirPriority: number } = {
        filePath: c.filePath,
        id: c.id,
        projectHash: c.projectHash,
        score,
        mtime: st.mtime.toISOString(),
        reason: "Tail JSONL contains match text.",
        dirPriority: c.dirPriority,
      };
      if (lastActivity) hit.lastActivity = lastActivity;
      hits.push(hit);
    }

    hits.sort((a, b) => {
      const ta = a.lastActivity ? Date.parse(a.lastActivity) : 0;
      const tb = b.lastActivity ? Date.parse(b.lastActivity) : 0;
      if (tb !== ta) return tb - ta;
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.mtime) - Date.parse(a.mtime);
    });

    const best = hits[0];
    if (!best) return unknownReport(opts.cwd, "[Claude] No session matched the provided --match text.");

    const confidence = scoreToConfidence(best.score, best.dirPriority < 9999 ? "match" : "fallback");
    const session: SessionHit = {
      path: best.filePath,
      id: best.id,
      agent: "claude",
      method: best.dirPriority < 9999 ? "match" : "fallback",
      confidence,
      score: best.score,
      cwd: opts.cwd,
      projectHash: best.projectHash,
      mtime: best.mtime,
    };
    if (best.lastActivity) session.lastActivity = best.lastActivity;
    if (opts.validate) session.health = (await validateHealth(best.filePath)).health;
    if (opts.includeSidechains) session.sidechains = await listClaudeSidechains(path.dirname(best.filePath));

    const alternatives: SessionAlternative[] = hits.slice(0, 5).map((h) => ({ path: h.filePath, score: h.score, reason: h.reason }));
    return { agent: "claude", cwd: opts.cwd, method: "match", confidence, session, alternatives };
  }

  // Strategy 3: rank candidates for cwd-hash vs fallback
  const ranked: Array<{
    filePath: string;
    id: string;
    projectHash: string;
    score: number;
    lastActivityMs: number;
    lastActivity?: string;
    mtimeMs: number;
    mtime: string;
    reason: string;
    method: SessionDiscoveryMethod;
  }> = [];

  for (const c of candidates.slice(0, opts.maxCandidates)) {
    const st = await fs.stat(c.filePath);
    const { jsonObjects, invalidJsonLines: invalidHead } = await readJsonlHead(c.filePath, 50);
    const { tail, invalidJsonLines: invalidTail } = await readJsonlTail(c.filePath, opts.tailLines);
    const tailJson = tail.filter((t): t is { kind: "json"; line: number; value: unknown } => t.kind === "json");
    const lastActivity = maxTimestampIso(tailJson.map((t) => t.value));
    const parsedLastActivityMs = lastActivity ? Date.parse(lastActivity) : 0;
    // If the file has no timestamps yet (often true right after Claude creates a new session file),
    // fall back to filesystem mtime as a best-effort activity proxy.
    const lastActivityMs = Number.isFinite(parsedLastActivityMs) && parsedLastActivityMs > 0 ? parsedLastActivityMs : st.mtimeMs;

    const headHasMessages = jsonObjects.some((o) => {
      const t = asString(o.type);
      return t === "user" || t === "assistant";
    });
    const tailHasMessages = tail.some(
      (t) => t.kind === "json" && isJsonObject(t.value) && (asString(t.value.type) === "user" || asString(t.value.type) === "assistant"),
    );
    const hasMessages = headHasMessages || tailHasMessages;

    // Exclude "summary-only / snapshot-only" files which are not resumeable and confuse status output.
    if (st.size > 0 && !hasMessages) continue;

    const sessionIds = new Set<string>();
    const cwds = new Set<string>();
    for (const obj of jsonObjects) {
      const sid = asString(obj.sessionId);
      if (sid) sessionIds.add(sid);
      const cwd = asString(obj.cwd);
      if (cwd) cwds.add(cwd);
    }

    let score = 0;
    const inProjectDir = c.dirPriority < 9999;
    if (inProjectDir) score += 100;
    if (sessionIds.has(c.id)) score += 30;
    else if (sessionIds.size > 0) score -= 10;

    if (cwds.size > 0) {
      const normalizedTargets = new Set(cwdCandidates);
      let hasMatch = false;
      for (const found of cwds) {
        if (normalizedTargets.has(found)) {
          hasMatch = true;
          break;
        }
      }
      if (hasMatch) score += 20;
    }

    const detected = await detectSession(c.filePath);
    if (detected.agent === "claude" && (detected.confidence === "high" || detected.confidence === "medium")) {
      score += 20;
    } else if (st.size === 0) {
      // A zero-byte *.jsonl inside the project dir is a common "brand new session" artifact.
      // Do not disqualify it just because it has no JSON signature yet.
    } else {
      score -= 100;
    }

    const invalid = invalidHead + invalidTail;
    if (invalid > 0) score -= 50;

    const method: SessionDiscoveryMethod = "cwd-hash";
    const reason = "Selected from project directory derived from CWD hash.";

    const item: {
      filePath: string;
      id: string;
      projectHash: string;
      score: number;
      lastActivityMs: number;
      lastActivity?: string;
      mtimeMs: number;
      mtime: string;
      reason: string;
      method: SessionDiscoveryMethod;
    } = {
      filePath: c.filePath,
      id: c.id,
      projectHash: c.projectHash,
      score,
      lastActivityMs,
      mtimeMs: st.mtimeMs,
      mtime: st.mtime.toISOString(),
      reason,
      method,
    };
    if (lastActivity) item.lastActivity = lastActivity;
    ranked.push(item);
  }

  ranked.sort((a, b) => {
    if (b.lastActivityMs !== a.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });

  const best = ranked[0];
  if (!best) return unknownReport(opts.cwd, "[Claude] Failed to rank any candidates.");

  let confidence = scoreToConfidence(best.score, best.method);
  const runnerUp = ranked[1];
  if (runnerUp && confidence === "high") {
    const now = Date.now();
    const ok = isStrictFallbackAllowed({
      top: { ageMs: now - best.lastActivityMs, score: best.score },
      runnerUp: { ageMs: now - runnerUp.lastActivityMs, score: runnerUp.score },
    });
    if (!ok) confidence = "medium";
  }
  const session: SessionHit = {
    path: best.filePath,
    id: best.id,
    agent: "claude",
    method: best.method,
    confidence,
    score: best.score,
    cwd: opts.cwd,
    projectHash: best.projectHash,
    mtime: best.mtime,
  };
  if (best.lastActivity) session.lastActivity = best.lastActivity;
  if (opts.validate) session.health = (await validateHealth(best.filePath)).health;
  if (opts.includeSidechains) session.sidechains = await listClaudeSidechains(path.dirname(best.filePath));

  const alternatives: SessionAlternative[] = ranked.slice(1, 6).map((r) => ({ path: r.filePath, score: r.score, reason: r.reason }));
  return { agent: "claude", cwd: opts.cwd, method: best.method, confidence, session, alternatives };
}
