import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { fileExists, writeFileAtomic } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { type JsonlLine, loadJsonlFile } from "../core/jsonl.js";
import { expandHome } from "../core/paths.js";
import { isUuid } from "../integrations/claude/context.js";
import { defaultClaudeProjectsDir } from "../integrations/claude/paths.js";
import { resolveClaudeTranscriptByUuidInProject } from "../integrations/claude/session-discovery.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";

type AgentChoice = "auto" | "claude" | "codex";

function isPathLike(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.endsWith(".jsonl") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".")
  );
}

function findCodexConversationId(lines: JsonlLine[], format: "wrapped" | "legacy"): string | undefined {
  if (format === "wrapped") {
    for (const line of lines) {
      if (line.kind !== "json") continue;
      if (!isJsonObject(line.value)) continue;
      if (asString(line.value.type) !== "session_meta") continue;
      const payload = line.value.payload;
      if (!isJsonObject(payload)) continue;
      const id = asString(payload.id);
      if (id) return id;
    }
    return undefined;
  }

  for (const line of lines) {
    if (line.kind !== "json") continue;
    if (!isJsonObject(line.value)) continue;
    const id = asString(line.value.id);
    const ts = asString(line.value.timestamp);
    const t = asString(line.value.type);
    if (id && ts && !t) return id;
  }
  return undefined;
}

function buildCodexForkBaseName(sourceBaseName: string, oldId: string | undefined, newId: string): string {
  const suffix = ".jsonl";
  if (!sourceBaseName.endsWith(suffix)) return `rollout-fork-${newId}.jsonl`;

  if (oldId) {
    const withDash = `-${oldId}${suffix}`;
    if (sourceBaseName.endsWith(withDash)) {
      return sourceBaseName.slice(0, -withDash.length) + `-${newId}${suffix}`;
    }
    const bare = `${oldId}${suffix}`;
    if (sourceBaseName.endsWith(bare)) {
      return sourceBaseName.slice(0, -bare.length) + `${newId}${suffix}`;
    }
  }

  return `rollout-fork-${newId}.jsonl`;
}

function rewriteClaudeForkLine(value: Record<string, unknown>, newSessionId: string): void {
  const sid = asString(value.sessionId);
  if (!sid) return;
  value.sessionId = newSessionId;
}

function rewriteCodexWrappedForkLine(value: Record<string, unknown>, newConversationId: string): void {
  const type = asString(value.type);
  if (type !== "session_meta") return;
  const payload = value.payload;
  if (!isJsonObject(payload)) return;
  payload.id = newConversationId;
}

function rewriteCodexLegacyForkLine(value: Record<string, unknown>, newConversationId: string): boolean {
  const id = asString(value.id);
  const ts = asString(value.timestamp);
  const t = asString(value.type);
  if (!id || !ts || t) return false;
  value.id = newConversationId;
  return true;
}

function serializeForkedJsonl(lines: JsonlLine[], mutate: (value: Record<string, unknown>) => void): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "invalid_json") {
      out.push(line.raw);
      continue;
    }
    if (!isJsonObject(line.value)) {
      out.push(JSON.stringify(line.value));
      continue;
    }
    mutate(line.value);
    out.push(JSON.stringify(line.value));
  }
  return out.join("\n") + "\n";
}

async function resolveSessionPathForFork(params: {
  agent: AgentChoice;
  idArg: string | undefined;
  cwd: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  lookbackDays: number;
}): Promise<{ path: string; agent: "claude" | "codex" } | { error: string; exitCode: number }> {
  const idRaw = params.idArg?.trim();

  if (idRaw && idRaw.length > 0 && isPathLike(idRaw)) {
    const resolved = path.resolve(expandHome(idRaw));
    if (!(await fileExists(resolved))) {
      return { error: `[evs fork] Session file not found: ${resolved}`, exitCode: 2 };
    }
    const detected = await detectSession(resolved);
    if (detected.agent === "claude") return { path: resolved, agent: "claude" };
    if (detected.agent === "codex") return { path: resolved, agent: "codex" };
    return { error: "[evs fork] Unsupported or unknown session format (expected Claude or Codex JSONL).", exitCode: 2 };
  }

  if (idRaw && idRaw.length > 0) {
    const wantsClaude = params.agent === "auto" || params.agent === "claude";
    const wantsCodex = params.agent === "auto" || params.agent === "codex";

    if (wantsClaude && !isUuid(idRaw) && params.agent === "claude") {
      return { error: "[evs fork] Claude sessions use UUIDs. Pass a UUID or a .jsonl path.", exitCode: 2 };
    }

    const canTryClaude = wantsClaude && isUuid(idRaw);
    const claudePath = canTryClaude
      ? await resolveClaudeTranscriptByUuidInProject({
          uuid: idRaw,
          cwd: params.cwd,
          claudeProjectsDir: params.claudeProjectsDir,
        })
      : undefined;

    const codexReport = wantsCodex
      ? await discoverCodexSessionReport({
          cwd: params.cwd,
          codexSessionsDir: params.codexSessionsDir,
          sessionId: idRaw,
          fallback: true,
          lookbackDays: params.lookbackDays,
          maxCandidates: 200,
          tailLines: 500,
          validate: false,
        })
      : undefined;

    const codexPath = codexReport?.agent === "codex" ? codexReport.session.path : undefined;

    if (claudePath && codexPath && params.agent === "auto") {
      return {
        error: "[evs fork] UUID matches both a Claude and a Codex session. Re-run with --agent claude|codex.",
        exitCode: 2,
      };
    }
    if (claudePath) return { path: claudePath, agent: "claude" };
    if (codexPath) return { path: codexPath, agent: "codex" };

    if (params.agent === "claude") {
      return { error: `[evs fork] No Claude session found for id=${idRaw} in this project.`, exitCode: 2 };
    }
    if (params.agent === "codex") {
      return { error: `[evs fork] No Codex session found for id=${idRaw} in lookback window.`, exitCode: 2 };
    }
    return { error: `[evs fork] No session found for id=${idRaw}.`, exitCode: 2 };
  }

  // No id: only Claude “active session” makes sense.
  return { error: "[evs fork] Missing session. Pass a UUID or a .jsonl path.", exitCode: 2 };
}

type ForkCommandOptions = {
  agent?: string;
  cwd?: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  lookbackDays?: string;
};

export function registerForkCommand(program: Command): void {
  program
    .command("fork")
    .description("Clone a Claude/Codex session and generate a new UUID (prints the new id)")
    .argument("[id]", "session UUID or .jsonl path")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--cwd <path>", "working directory used for UUID resolution (default: process.cwd())")
    .option("--claude-projects-dir <dir>", "override ~/.claude/projects (advanced)")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .option("--lookback-days <n>", "Codex: how many days back to scan (default: 14)", "14")
    .action(async (idArg: string | undefined, opts: ForkCommandOptions) => {
      const cwd = typeof opts.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : process.cwd();
      const agent = (asString(opts.agent) ?? "auto") as AgentChoice;
      if (agent !== "auto" && agent !== "claude" && agent !== "codex") {
        process.stderr.write("[evs fork] Invalid --agent value (expected auto|claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const claudeProjectsDir =
        typeof opts.claudeProjectsDir === "string" && opts.claudeProjectsDir.trim().length > 0
          ? opts.claudeProjectsDir
          : defaultClaudeProjectsDir();
      const codexSessionsDir =
        typeof opts.codexSessionsDir === "string" && opts.codexSessionsDir.trim().length > 0
          ? opts.codexSessionsDir
          : defaultCodexSessionsDir();
      const lookbackDaysRaw = typeof opts.lookbackDays === "string" ? opts.lookbackDays : "14";
      const lookbackDaysParsed = Number(lookbackDaysRaw);
      const lookbackDays =
        Number.isFinite(lookbackDaysParsed) && lookbackDaysParsed > 0 ? Math.floor(lookbackDaysParsed) : 14;

      const resolved = await resolveSessionPathForFork({
        agent,
        idArg,
        cwd,
        claudeProjectsDir,
        codexSessionsDir,
        lookbackDays,
      });
      if ("error" in resolved) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }

      const sourcePath = resolved.path;
      const detected = await detectSession(sourcePath);
      if (detected.agent !== "claude" && detected.agent !== "codex") {
        process.stderr.write("[evs fork] Unsupported or unknown session format (expected Claude or Codex JSONL).\n");
        process.exitCode = 2;
        return;
      }

      // Retry on collisions (very unlikely).
      let newId = crypto.randomUUID();
      for (let i = 0; i < 5; i += 1) {
        const target = detected.agent === "claude" ? path.join(path.dirname(sourcePath), `${newId}.jsonl`) : undefined;
        if (!target) break;
        if (!(await fileExists(target))) break;
        newId = crypto.randomUUID();
      }

      const jsonl = await loadJsonlFile(sourcePath);

      let targetPath: string;
      let content: string;

      if (detected.agent === "claude") {
        targetPath = path.join(path.dirname(sourcePath), `${newId}.jsonl`);
        if (await fileExists(targetPath)) {
          process.stderr.write("[evs fork] Target file already exists; retry.\n");
          process.exitCode = 2;
          return;
        }

        content = serializeForkedJsonl(jsonl, (v) => rewriteClaudeForkLine(v, newId));
      } else {
        const format = detected.format === "legacy" ? "legacy" : "wrapped";
        const oldId = findCodexConversationId(jsonl, format);
        const baseName = path.basename(sourcePath);
        const newBaseName = buildCodexForkBaseName(baseName, oldId, newId);
        targetPath = path.join(path.dirname(sourcePath), newBaseName);

        if (await fileExists(targetPath)) {
          process.stderr.write("[evs fork] Target file already exists; retry.\n");
          process.exitCode = 2;
          return;
        }

        if (format === "wrapped") {
          content = serializeForkedJsonl(jsonl, (v) => rewriteCodexWrappedForkLine(v, newId));
        } else {
          let updatedMeta = false;
          content = serializeForkedJsonl(jsonl, (v) => {
            if (updatedMeta) return;
            updatedMeta = rewriteCodexLegacyForkLine(v, newId) || updatedMeta;
          });
        }
      }

      await writeFileAtomic(targetPath, content);
      process.stdout.write(newId + "\n");
      process.exitCode = 0;
    });
}
