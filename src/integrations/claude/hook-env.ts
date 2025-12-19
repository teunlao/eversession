import * as fs from "node:fs/promises";
import * as path from "node:path";

import { deriveSessionIdFromPath } from "../../core/paths.js";
import { resolveClaudeEnvFilePathFromEnv, resolveClaudeProjectDirFromEnv } from "./context.js";
import { readClaudeHookInputIfAny } from "./hook-input.js";

function envValue(value: string): string {
  // Safe default for a shell-style env file.
  // If it is simple, keep it unquoted; otherwise single-quote and escape.
  if (/^[A-Za-z0-9_\/:.\-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function appendEnvVar(envFilePath: string, key: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(envFilePath), { recursive: true });
  // Use `export` so the variable is visible to child processes (e.g. `printenv`, and tools reading process.env).
  await fs.appendFile(envFilePath, `export ${key}=${envValue(value)}\n`, "utf8");
}

type HookEnvLogEvent = {
  ts: string;
  cwd: string;
  envFile?: string;
  transcriptPath?: string;
  transcriptUuid?: string;
  hookSessionId?: string;
  claudeProjectDir?: string;
  note: string;
};

function buildHookEnvLogEvent(params: {
  ts: string;
  cwd: string;
  note: string;
  envFilePath?: string | undefined;
  transcriptPath?: string | undefined;
  transcriptUuid?: string | undefined;
  hookSessionId?: string | undefined;
  claudeProjectDir?: string | undefined;
}): HookEnvLogEvent {
  return {
    ts: params.ts,
    cwd: params.cwd,
    note: params.note,
    ...(params.envFilePath ? { envFile: params.envFilePath } : {}),
    ...(params.transcriptPath ? { transcriptPath: params.transcriptPath } : {}),
    ...(params.transcriptUuid ? { transcriptUuid: params.transcriptUuid } : {}),
    ...(params.hookSessionId ? { hookSessionId: params.hookSessionId } : {}),
    ...(params.claudeProjectDir ? { claudeProjectDir: params.claudeProjectDir } : {}),
  };
}

async function appendHookEnvLog(event: HookEnvLogEvent): Promise<void> {
  const baseDir = event.claudeProjectDir ?? event.cwd;
  const logPath = path.join(baseDir, ".evs.hook-env.log");
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Never fail the hook because of logging.
  }
}

export async function runClaudeHookEnvCommand(): Promise<void> {
  const envFilePath = resolveClaudeEnvFilePathFromEnv();
  const hook = await readClaudeHookInputIfAny(25);
  const transcriptPath = hook?.transcriptPath;
  const claudeProjectDir = resolveClaudeProjectDirFromEnv();

  const transcriptUuid = transcriptPath ? deriveSessionIdFromPath(transcriptPath) : undefined;

  if (!envFilePath) {
    await appendHookEnvLog(
      buildHookEnvLogEvent({
        ts: new Date().toISOString(),
        cwd: process.cwd(),
        transcriptPath,
        transcriptUuid,
        hookSessionId: hook?.sessionId,
        claudeProjectDir,
        note: "skip: no CLAUDE_ENV_FILE",
      }),
    );
    return;
  }

  if (!transcriptPath) {
    await appendHookEnvLog(
      buildHookEnvLogEvent({
        ts: new Date().toISOString(),
        cwd: process.cwd(),
        envFilePath,
        hookSessionId: hook?.sessionId,
        claudeProjectDir,
        note: "skip: no transcript_path in hook payload",
      }),
    );
    return;
  }

  await appendEnvVar(envFilePath, "EVS_CLAUDE_TRANSCRIPT_PATH", transcriptPath);

  if (transcriptUuid) await appendEnvVar(envFilePath, "EVS_CLAUDE_TRANSCRIPT_UUID", transcriptUuid);

  if (hook?.sessionId) await appendEnvVar(envFilePath, "EVS_CLAUDE_SESSION_ID", hook.sessionId);
  if (hook?.cwd) await appendEnvVar(envFilePath, "EVS_CLAUDE_HOOK_CWD", hook.cwd);
  if (claudeProjectDir) await appendEnvVar(envFilePath, "EVS_CLAUDE_PROJECT_DIR", claudeProjectDir);

  await appendHookEnvLog(
    buildHookEnvLogEvent({
      ts: new Date().toISOString(),
      cwd: process.cwd(),
      envFilePath,
      transcriptPath,
      transcriptUuid,
      hookSessionId: hook?.sessionId,
      claudeProjectDir,
      note: "ok: wrote env vars",
    }),
  );
}
