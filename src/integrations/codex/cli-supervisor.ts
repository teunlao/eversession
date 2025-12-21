import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { fileExists } from "../../core/fs.js";
import { expandHome } from "../../core/paths.js";
import { defaultCodexBin, findExecutableOnPath, isPathLike } from "./bin.js";
import { parseReloadMode, type ReloadMode } from "./supervisor-control.js";
import { runCodexSupervisorRunner } from "./supervisor-runner.js";

type CodexReloadFlag = string | undefined;

type CodexSupervisorCommandParams = {
  reloadFlag?: CodexReloadFlag;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function resolveReloadMode(flag: CodexReloadFlag): ReloadMode {
  return parseReloadMode(flag) ?? "manual";
}

export async function executeCodexSupervisorCommand(params: CodexSupervisorCommandParams): Promise<number> {
  const reloadMode = resolveReloadMode(params.reloadFlag);

  const runId = crypto.randomUUID();
  const controlDir = path.join(os.tmpdir(), "evs-codex", runId);
  await fs.mkdir(controlDir, { recursive: true });

  const rawBin = defaultCodexBin();
  const bin = isPathLike(rawBin) ? path.resolve(expandHome(rawBin)) : rawBin;

  if (isPathLike(rawBin)) {
    if (!(await fileExists(bin))) {
      process.stderr.write(`[evs codex] Codex executable not found: ${bin}\n`);
      return 127;
    }
  } else {
    const resolved = await findExecutableOnPath(bin, params.env.PATH);
    if (!resolved) {
      process.stderr.write("[evs codex] Codex executable not found on PATH. Install it or set EVS_CODEX_BIN.\n");
      return 127;
    }
  }

  const userArgs = params.args.map((a) => String(a));

  // Always inject our notify hook so we can track thread-id and enable reload/resume safely.
  const notifyOverrideArgs = ["--config", 'notify=["evs","codex","notify","--auto-compact"]'] as const;
  const initialArgs = [...notifyOverrideArgs, ...userArgs];
  const resumeArgs = (threadId: string): string[] => [...notifyOverrideArgs, "resume", threadId];

  const { exitCode } = await runCodexSupervisorRunner({
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
}
