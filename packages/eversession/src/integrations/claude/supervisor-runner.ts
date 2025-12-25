import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";

import { fileExists } from "../../core/fs.js";
import { applyClaudePendingCompactOnReload } from "./auto-compact.js";
import { fixSessionBeforeReload } from "./post-reload-fix.js";
import {
  type ClaudeSupervisorControlCommand,
  controlLogPathForControlDir,
  parseSupervisorControlCommandLine,
  type ReloadMode,
  readSupervisorHandshake,
} from "./supervisor-control.js";

export type ClaudeSupervisorProcess = {
  exitCode: number;
};

export type ClaudeSupervisorRunnerOptions = {
  bin: string;
  initialArgs: string[];
  resumeArgs: (sessionId: string) => string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  controlDir: string;
  runId: string;
  reloadMode: ReloadMode;
  pollIntervalMs: number;
  handshakeTimeoutMs: number;
  restartTimeoutMs: number;
  signal?: AbortSignal;
};

type ExitStatus = { code: number } | { signal: NodeJS.Signals } | { unknown: true };

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

function exitStatusFrom(code: number | null, signal: NodeJS.Signals | null): ExitStatus {
  if (typeof code === "number") return { code };
  if (signal) return { signal };
  return { unknown: true };
}

async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);

    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

async function waitForHandshake(params: {
  controlDir: string;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<
  | {
      sessionId: string;
      transcriptPath: string;
    }
  | undefined
> {
  const deadline = Date.now() + params.timeoutMs;
  while (!params.signal?.aborted) {
    const hs = await readSupervisorHandshake(params.controlDir);
    if (hs && hs.runId === params.runId) return { sessionId: hs.sessionId, transcriptPath: hs.transcriptPath };
    if (Date.now() >= deadline) return undefined;
    await delay(200, params.signal);
  }
  return undefined;
}

async function readNewControlCommands(params: { controlDir: string; fromLine: number }): Promise<{
  commands: ClaudeSupervisorControlCommand[];
  nextLine: number;
}> {
  const filePath = controlLogPathForControlDir(params.controlDir);
  if (!(await fileExists(filePath))) return { commands: [], nextLine: params.fromLine };
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return { commands: [], nextLine: params.fromLine };
  }

  const lines = text.split("\n");
  // JSONL files typically end with a trailing newline; `split("\n")` yields a trailing empty string.
  // If we count that as a line, the cursor becomes off-by-one and we can miss newly appended commands.
  const effectiveLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const newLines = effectiveLines.slice(params.fromLine);
  const commands: ClaudeSupervisorControlCommand[] = [];
  for (const line of newLines) {
    const cmd = parseSupervisorControlCommandLine(line);
    if (cmd) commands.push(cmd);
  }
  return { commands, nextLine: effectiveLines.length };
}

function spawnChild(params: { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }): ChildProcess {
  return spawn(params.bin, params.args, {
    stdio: "inherit",
    env: params.env,
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
  });
}

export async function runClaudeSupervisorRunner(opts: ClaudeSupervisorRunnerOptions): Promise<ClaudeSupervisorProcess> {
  const baseEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    EVS_CLAUDE_CONTROL_DIR: opts.controlDir,
    EVS_CLAUDE_RUN_ID: opts.runId,
    EVS_CLAUDE_RELOAD_MODE: opts.reloadMode,
  };

  let controlLine = 0;
  let restarting = false;
  let pendingReload = false;

  let activeToken = Symbol("child");
  let lastExit: ExitStatus | undefined;

  const attachExitHandler = (child: ChildProcess, token: symbol): void => {
    child.on("error", (err) => {
      if (token !== activeToken) return;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[evs claude] Failed to spawn ${opts.bin}: ${message}\n`);
      lastExit = { code: 127 };
    });

    child.on("exit", (code, signal) => {
      if (token !== activeToken) return;
      if (restarting) return;
      lastExit = exitStatusFrom(code, signal);
    });
  };

  let child = spawnChild({
    bin: opts.bin,
    args: opts.initialArgs,
    env: baseEnv,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  attachExitHandler(child, activeToken);

  while (!opts.signal?.aborted) {
    if (lastExit) break;

    const read = await readNewControlCommands({ controlDir: opts.controlDir, fromLine: controlLine });
    controlLine = read.nextLine;
    for (const cmd of read.commands) {
      if (cmd.cmd === "reload") pendingReload = true;
    }

    if (pendingReload && !restarting) {
      pendingReload = false;
      restarting = true;

      const hs = await waitForHandshake({
        controlDir: opts.controlDir,
        runId: opts.runId,
        timeoutMs: opts.handshakeTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (!hs) {
        restarting = false;
      } else {
        await stopChild(child, opts.restartTimeoutMs);

        // Apply pending compaction before restart (safe boundary: Claude child is stopped).
        try {
          const apply = await applyClaudePendingCompactOnReload({
            sessionId: hs.sessionId,
            sessionPath: hs.transcriptPath,
            busyTimeoutMs: 10_000,
          });
          if (apply.applied) {
            const afterText = apply.tokensAfter === undefined ? "" : `→${apply.tokensAfter}`;
            process.stderr.write(`[evs claude] Applied pending compact: tokens=${apply.tokensBefore}${afterText}\n`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[evs claude] Warning: pending compact apply failed: ${message}\n`);
        }

        // Fix session issues before restart (broken chains, thinking order, orphans, etc.)
        try {
          const fixResult = await fixSessionBeforeReload(hs.transcriptPath);
          if (fixResult.fixed) {
            process.stderr.write(`[evs claude] Fixed ${fixResult.changes} issue(s) before restart\n`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[evs claude] Warning: pre-reload fix failed: ${message}\n`);
        }

        activeToken = Symbol("child");
        child = spawnChild({
          bin: opts.bin,
          args: opts.resumeArgs(hs.sessionId),
          env: baseEnv,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
        attachExitHandler(child, activeToken);
        restarting = false;
      }
    }

    await delay(opts.pollIntervalMs, opts.signal);
  }

  if (opts.signal?.aborted) {
    restarting = true;
    await stopChild(child, opts.restartTimeoutMs);
    return { exitCode: 0 };
  }

  if (!lastExit) return { exitCode: 0 };
  if ("code" in lastExit) return { exitCode: lastExit.code };
  return { exitCode: 1 };
}
