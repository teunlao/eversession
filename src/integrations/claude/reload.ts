import { deriveSessionIdFromPath } from "../../core/paths.js";
import { resolveClaudeKnownSessionId } from "./context.js";
import { readClaudeHookInputIfAny } from "./hook-input.js";
import { updateSessionState } from "./eversession-session-storage.js";
import {
  appendSupervisorControlCommand,
  clearPendingReload,
  readClaudeSupervisorEnv,
  readSupervisorHandshake,
} from "./supervisor-control.js";

function printManualReload(sessionId: string): void {
  process.stdout.write(`Manual reload:\nCtrl+D, then run:\nevs claude --resume ${sessionId}\n`);
}

export async function runClaudeReloadCommand(sessionIdArg?: string): Promise<void> {
  const supervisor = readClaudeSupervisorEnv();
  if (supervisor) {
    try {
      await appendSupervisorControlCommand({
        controlDir: supervisor.controlDir,
        command: { ts: new Date().toISOString(), cmd: "reload", reason: "manual" },
      });
      await clearPendingReload(supervisor.controlDir);

      // Best-effort: if a session has "pending reload" state (auto-compact), clear it to avoid double reload loops.
      const hs = await readSupervisorHandshake(supervisor.controlDir);
      if (hs) {
        try {
          await updateSessionState(hs.sessionId, { pendingReload: null });
        } catch {
          // ignore
        }
      }
    } catch {
      process.stderr.write("[evs reload] Failed to write reload request to supervisor control channel.\n");
      process.exitCode = 1;
    }
    return;
  }

  const known = resolveClaudeKnownSessionId(sessionIdArg);
  if (known) {
    printManualReload(known);
    return;
  }

  const hook = await readClaudeHookInputIfAny(25);
  const fallbackFromHook =
    hook?.sessionId ?? (hook?.transcriptPath ? deriveSessionIdFromPath(hook.transcriptPath) : undefined);
  if (fallbackFromHook) {
    printManualReload(fallbackFromHook);
    return;
  }

  process.stdout.write("Manual reload:\nCtrl+D, then run:\nevs claude --resume <session-id>\n");
  process.exitCode = 2;
}
