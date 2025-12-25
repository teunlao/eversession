import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { removeActiveRunRecord, writeActiveRunRecord } from "../../core/active-run-registry.js";
import { fileExists } from "../../core/fs.js";
import { expandHome } from "../../core/paths.js";
import { stripClaudeSessionSelectionArgs } from "./args.js";
import { defaultClaudeBin, findExecutableOnPath, isPathLike } from "./bin.js";
import { defaultClaudeLocalBin } from "./paths.js";
import { parseReloadMode, type ReloadMode } from "./supervisor-control.js";
import { runClaudeSupervisorRunner } from "./supervisor-runner.js";

type ClaudeReloadFlag = string | undefined;

type ClaudeSupervisorCommandParams = {
  reloadFlag?: ClaudeReloadFlag;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function resolveReloadMode(flag: ClaudeReloadFlag): ReloadMode {
  return parseReloadMode(flag) ?? "manual";
}

export async function executeClaudeSupervisorCommand(params: ClaudeSupervisorCommandParams): Promise<number> {
  const reloadMode = resolveReloadMode(params.reloadFlag);

  const runId = crypto.randomUUID();
  const controlDir = path.join(os.tmpdir(), "evs-claude", runId);
  await fs.mkdir(controlDir, { recursive: true });

  const rawBin = await defaultClaudeBin();
  const bin = isPathLike(rawBin) ? path.resolve(expandHome(rawBin)) : rawBin;

  if (isPathLike(rawBin)) {
    if (!(await fileExists(bin))) {
      process.stderr.write(`[evs claude] Claude executable not found: ${bin}\n`);
      return 127;
    }
  } else {
    const resolved = await findExecutableOnPath(bin, params.env.PATH);
    if (!resolved) {
      const local = defaultClaudeLocalBin();
      if (await fileExists(local)) {
        process.stderr.write(`[evs claude] Claude executable not found on PATH. Try:\n  evs claude --bin ${local}\n`);
      } else {
        process.stderr.write("[evs claude] Claude executable not found on PATH. Provide --bin /path/to/claude\n");
      }
      return 127;
    }
  }

  const initialArgs = params.args.map((a) => String(a));
  const stableArgs = stripClaudeSessionSelectionArgs(initialArgs);
  const resumeArgs = (sessionId: string): string[] => ["--resume", sessionId, ...stableArgs];

  await writeActiveRunRecord({
    schemaVersion: 1,
    agent: "claude",
    runId,
    pid: process.pid,
    controlDir,
    cwd: process.cwd(),
    reloadMode,
    startedAt: new Date().toISOString(),
  });

  try {
    const { exitCode } = await runClaudeSupervisorRunner({
      bin,
      initialArgs,
      resumeArgs,
      env: params.env,
      controlDir,
      runId,
      reloadMode,
      pollIntervalMs: 200,
      handshakeTimeoutMs: 5000,
      restartTimeoutMs: 5000,
    });

    return exitCode;
  } finally {
    await removeActiveRunRecord("claude", runId);
  }
}
