import * as fs from "node:fs/promises";
import * as path from "node:path";

import { discoverClaudeSession } from "../../agents/claude/discover.js";
import type { SessionDiscoveryReport } from "../../agents/session-discovery/types.js";
import { defaultClaudeProjectsDir } from "./paths.js";

function cwdHashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

function cwdHashV1(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

async function listSessionCandidates(projectDir: string): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("agent-"))
      .map((e) => e.name);
    const out: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const name of files) {
      const filePath = path.join(projectDir, name);
      try {
        const st = await fs.stat(filePath);
        out.push({ filePath, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch {
    return [];
  }
}

export async function resolveCurrentClaudeSessionPath(cwd: string, opts?: { claudeProjectsDir?: string }): Promise<string | undefined> {
  const baseDir = opts?.claudeProjectsDir ?? defaultClaudeProjectsDir();
  const hashes = [cwdHashV2(cwd), cwdHashV1(cwd)];
  for (const h of hashes) {
    const dir = path.join(baseDir, h);
    const candidates = await listSessionCandidates(dir);
    if (candidates.length === 0) continue;
    return candidates[0]?.filePath;
  }
  return undefined;
}

export type ClaudeDiscoveryOptions = Parameters<typeof discoverClaudeSession>[0];

export async function discoverClaudeSessionReport(opts: ClaudeDiscoveryOptions): Promise<SessionDiscoveryReport> {
  return discoverClaudeSession(opts);
}

export async function resolveClaudeTranscriptByUuidInProject(params: {
  uuid: string;
  cwd: string;
  claudeProjectsDir?: string;
}): Promise<string | undefined> {
  const report = await discoverClaudeSession({
    cwd: params.cwd,
    claudeProjectsDir: params.claudeProjectsDir ?? defaultClaudeProjectsDir(),
    sessionId: params.uuid,
    fallback: false,
    maxCandidates: 200,
    tailLines: 500,
    includeSidechains: false,
    validate: false,
  });
  if (report.agent === "claude") return report.session.path;
  return undefined;
}
