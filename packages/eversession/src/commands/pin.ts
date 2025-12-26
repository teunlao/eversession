import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { readJsonlHead } from "../agents/session-discovery/shared.js";
import { fileExists } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { deriveSessionIdFromPath, expandHome } from "../core/paths.js";
import { isUuid } from "../integrations/claude/context.js";
import { defaultClaudeProjectsDir } from "../integrations/claude/paths.js";
import { resolveClaudeTranscriptByUuidInProject } from "../integrations/claude/session-discovery.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import {
  loadPinsFile,
  type PinnedAgent,
  type PinnedSession,
  resolvePinsPath,
  savePinsFile,
} from "../integrations/pins/storage.js";
import { resolveSessionForCli } from "./session-ref.js";

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

async function extractCodexConversationId(filePath: string): Promise<string | undefined> {
  const { jsonObjects } = await readJsonlHead(filePath, 200);

  for (const obj of jsonObjects) {
    const type = asString(obj.type);
    if (type !== "session_meta") continue;
    const payload = obj.payload;
    if (!isJsonObject(payload)) continue;
    const id = asString(payload.id);
    if (id) return id;
  }

  // Legacy: first meta line.
  for (const obj of jsonObjects) {
    const id = asString(obj.id);
    const ts = asString(obj.timestamp);
    const t = asString(obj.type);
    if (id && ts && !t) return id;
  }

  return undefined;
}

async function resolveSessionPathForPin(params: {
  agent: AgentChoice;
  refArg: string | undefined;
  cwd: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  lookbackDays: number;
}): Promise<{ sessionPath: string; agent: PinnedAgent } | { error: string; exitCode: number }> {
  const refRaw = params.refArg?.trim();

  if (refRaw && refRaw.length > 0 && isPathLike(refRaw)) {
    const resolved = path.resolve(expandHome(refRaw));
    if (!(await fileExists(resolved))) {
      return { error: `[evs pin] Session file not found: ${resolved}`, exitCode: 2 };
    }
    const detected = await detectSession(resolved);
    if (detected.agent === "claude") return { sessionPath: resolved, agent: "claude" };
    if (detected.agent === "codex") return { sessionPath: resolved, agent: "codex" };
    return { error: "[evs pin] Unsupported or unknown session format (expected Claude or Codex JSONL).", exitCode: 2 };
  }

  if (refRaw && refRaw.length > 0) {
    const wantsClaude = params.agent === "auto" || params.agent === "claude";
    const wantsCodex = params.agent === "auto" || params.agent === "codex";

    if (wantsClaude && !isUuid(refRaw) && params.agent === "claude") {
      return { error: "[evs pin] Claude sessions use UUIDs. Pass a UUID or a .jsonl path.", exitCode: 2 };
    }

    const canTryClaude = wantsClaude && isUuid(refRaw);
    const claudePath = canTryClaude
      ? await resolveClaudeTranscriptByUuidInProject({
          uuid: refRaw,
          cwd: params.cwd,
          claudeProjectsDir: params.claudeProjectsDir,
        })
      : undefined;

    const codexReport = wantsCodex
      ? await discoverCodexSessionReport({
          cwd: params.cwd,
          codexSessionsDir: params.codexSessionsDir,
          sessionId: refRaw,
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
        error: "[evs pin] UUID matches both a Claude and a Codex session. Re-run with --agent claude|codex.",
        exitCode: 2,
      };
    }
    if (claudePath) return { sessionPath: claudePath, agent: "claude" };
    if (codexPath) return { sessionPath: codexPath, agent: "codex" };

    if (params.agent === "claude") {
      return { error: `[evs pin] No Claude session found for id=${refRaw} in this project.`, exitCode: 2 };
    }
    if (params.agent === "codex") {
      return { error: `[evs pin] No Codex session found for id=${refRaw} in lookback window.`, exitCode: 2 };
    }
    return { error: `[evs pin] No session found for id=${refRaw}.`, exitCode: 2 };
  }

  // No ref: only allowed under an active EVS supervisor.
  const resolved = await resolveSessionForCli({ commandLabel: "pin", cwd: params.cwd });
  if (!resolved.ok) return { error: resolved.error, exitCode: resolved.exitCode };
  if (params.agent !== "auto" && resolved.value.agent !== params.agent) {
    return {
      exitCode: 2,
      error: `[evs pin] Current session is ${resolved.value.agent}. Re-run with an explicit ref, or omit --agent.`,
    };
  }
  return { sessionPath: resolved.value.sessionPath, agent: resolved.value.agent };
}

function safeParseTimeMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

type PinCommandOptions = {
  agent?: string;
  cwd?: string;
  force?: boolean;
  json?: boolean;
  pinsPath?: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  lookbackDays?: string;
};

export function registerPinCommand(program: Command): void {
  program
    .command("pin")
    .description("Save a session under a name")
    .argument("<name>", "pin name")
    .argument("[ref]", "session UUID or .jsonl path")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--force", "overwrite an existing pin with the same name")
    .option("--json", "output the pinned record as JSON")
    .option("--pins-path <path>", "override pins file path (advanced)")
    .option("--cwd <path>", "working directory used for UUID resolution (default: process.cwd())")
    .option("--claude-projects-dir <dir>", "override ~/.claude/projects (advanced)")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .option("--lookback-days <n>", "Codex: how many days back to scan (default: 14)", "14")
    .action(async (nameArg: string, refArg: string | undefined, opts: PinCommandOptions) => {
      const name = nameArg.trim();
      if (name.length === 0) {
        process.stderr.write("[evs pin] Name is empty.\n");
        process.exitCode = 2;
        return;
      }

      const agent = (asString(opts.agent) ?? "auto") as AgentChoice;
      if (agent !== "auto" && agent !== "claude" && agent !== "codex") {
        process.stderr.write("[evs pin] Invalid --agent value (expected auto|claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const cwd = typeof opts.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : process.cwd();
      const pinsPath = resolvePinsPath(opts.pinsPath);
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

      const resolved = await resolveSessionPathForPin({
        agent,
        refArg,
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

      const sessionPath = resolved.sessionPath;
      const detected = await detectSession(sessionPath);
      if (detected.agent !== "claude" && detected.agent !== "codex") {
        process.stderr.write("[evs pin] Unsupported or unknown session format (expected Claude or Codex JSONL).\n");
        process.exitCode = 2;
        return;
      }

      const agentPinned: PinnedAgent = detected.agent;
      const sessionId =
        agentPinned === "claude" ? deriveSessionIdFromPath(sessionPath) : await extractCodexConversationId(sessionPath);
      if (!sessionId) {
        process.stderr.write("[evs pin] Failed to derive session id from file.\n");
        process.exitCode = 2;
        return;
      }

      let sessionMtime: string | undefined;
      try {
        const st = await fs.stat(sessionPath);
        sessionMtime = st.mtime.toISOString();
      } catch {
        // ignore
      }

      const record: PinnedSession = {
        name,
        agent: agentPinned,
        sessionId,
        sessionPath: path.resolve(sessionPath),
        pinnedAt: new Date().toISOString(),
        ...(sessionMtime ? { sessionMtime } : {}),
      };

      let pinsFile: Awaited<ReturnType<typeof loadPinsFile>>;
      try {
        pinsFile = await loadPinsFile(pinsPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs pin] Failed to read pins file: ${msg}\n`);
        process.exitCode = 2;
        return;
      }

      const existing = pinsFile.pins.find((p) => p.name === name);
      if (
        existing &&
        !opts.force &&
        (existing.agent !== record.agent ||
          existing.sessionId !== record.sessionId ||
          existing.sessionPath !== record.sessionPath)
      ) {
        process.stderr.write(`[evs pin] Pin already exists: ${name} (use --force to overwrite)\n`);
        process.exitCode = 2;
        return;
      }

      const pins = pinsFile.pins.filter((p) => p.name !== name);
      pins.push(record);
      pins.sort((a, b) => safeParseTimeMs(b.pinnedAt) - safeParseTimeMs(a.pinnedAt));

      try {
        await savePinsFile(pinsPath, pins);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs pin] Failed to write pins file: ${msg}\n`);
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(record, null, 2) + "\n");
        process.exitCode = 0;
        return;
      }

      process.stdout.write(`Pinned ${name}: agent=${record.agent} id=${record.sessionId}\n`);
      process.exitCode = 0;
    });
}
