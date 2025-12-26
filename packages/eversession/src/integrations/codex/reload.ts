import { resolveCodexStatePath, resolveCodexThreadIdForCwd } from "./state.js";
import { appendSupervisorControlCommand, readCodexSupervisorEnv } from "./supervisor-control.js";

function printManualReload(threadId: string): void {
  process.stdout.write(`Manual reload:\nCtrl+C, then run:\nevs codex resume ${threadId}\n`);
}

export async function runCodexReloadCommand(sessionIdArg?: string): Promise<void> {
  const supervisor = readCodexSupervisorEnv();
  if (supervisor) {
    try {
      await appendSupervisorControlCommand({
        controlDir: supervisor.controlDir,
        command: { ts: new Date().toISOString(), cmd: "reload", reason: "manual" },
      });
    } catch {
      process.stderr.write("[evs reload] Failed to write reload request to Codex supervisor control channel.\n");
      process.exitCode = 1;
    }
    return;
  }

  const explicit = sessionIdArg?.trim();
  if (explicit && explicit.length > 0) {
    printManualReload(explicit);
    return;
  }

  try {
    const statePath = resolveCodexStatePath();
    const threadId = await resolveCodexThreadIdForCwd({ cwd: process.cwd(), statePath });
    if (threadId) {
      printManualReload(threadId);
      return;
    }
  } catch {
    // ignore
  }

  process.stdout.write("Manual reload:\nCtrl+C, then run:\nevs codex resume <session-id>\n");
  process.exitCode = 2;
}
