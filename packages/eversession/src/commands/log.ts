import * as path from "node:path";
import * as fs from "node:fs/promises";

import type { Command } from "commander";

import { readJsonlHead } from "../agents/session-discovery/shared.js";
import { fileExists } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { getLogPath } from "../integrations/claude/eversession-session-storage.js";
import { formatClaudeAutoCompactLine, parseClaudeAutoCompactEntries } from "../integrations/claude/log.js";
import { resolveClaudeSessionLogPath } from "../integrations/claude/log-paths.js";
import { resolveSessionForCli } from "./session-ref.js";

function deriveCodexSessionIdFromTranscriptPath(transcriptPath: string): string | undefined {
  const base = path.basename(transcriptPath);
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

async function resolveCodexSessionIdFromTranscriptPath(transcriptPath: string): Promise<string | undefined> {
  const fromName = deriveCodexSessionIdFromTranscriptPath(transcriptPath);
  if (fromName) return fromName;

  try {
    const { jsonObjects } = await readJsonlHead(transcriptPath, 50);
    for (const obj of jsonObjects) {
      if (asString(obj.type) !== "session_meta") continue;
      const payload = obj.payload;
      if (!isJsonObject(payload)) continue;
      const id = asString(payload.id);
      if (id) return id;
    }
  } catch {
    // ignore
  }

  return undefined;
}

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .description("Show EVS auto-compact history for the current session")
    .argument("[ref]", "session id or .jsonl path (omit under evs supervisor)")
    .option("--agent <agent>", "claude|codex (optional; only needed when id is ambiguous)")
    .option("--tail <n>", "show last N entries (default: 20)", "20")
    .option("--all", "show all entries")
    .action(async (refArg: string | undefined, opts: { agent?: string; tail: string; all?: boolean }) => {
      const resolved = await resolveSessionForCli({ commandLabel: "log", refArg, agent: opts.agent });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }

      let logPath: string;
      if (resolved.value.agent === "claude") {
        const resolvedLog = await resolveClaudeSessionLogPath(resolved.value.sessionPath);
        if (!resolvedLog) {
          process.stderr.write("[evs log] No log file found for this session.\n");
          process.exitCode = 2;
          return;
        }
        logPath = resolvedLog.path;
      } else {
        const sessionId = await resolveCodexSessionIdFromTranscriptPath(resolved.value.sessionPath);
        if (!sessionId) {
          process.stderr.write("[evs log] Cannot determine Codex session id.\n");
          process.exitCode = 2;
          return;
        }
        logPath = getLogPath(sessionId);
        if (!(await fileExists(logPath))) {
          process.stderr.write("[evs log] No log file found for this session.\n");
          process.exitCode = 2;
          return;
        }
      }

      let raw: string;
      try {
        raw = await fs.readFile(logPath, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs log] Failed to read log: ${msg}\n`);
        process.exitCode = 2;
        return;
      }

      const entries = parseClaudeAutoCompactEntries(raw);
      if (entries.length === 0) {
        process.stdout.write("No auto-compact entries found.\n");
        process.exitCode = 0;
        return;
      }

      let tail = 20;
      if (opts.all) tail = entries.length;
      else {
        const parsed = Number.parseInt(opts.tail, 10);
        if (Number.isFinite(parsed) && parsed > 0) tail = parsed;
      }

      for (const entry of entries.slice(-tail)) {
        process.stdout.write(formatClaudeAutoCompactLine(entry) + "\n");
      }
      process.exitCode = 0;
    });
}

