import { deriveSessionIdFromPath } from "../../core/paths.js";
import { appendSessionLog, readSessionState, updateSessionState } from "./eversession-session-storage.js";
import { readClaudeHookInputIfAny } from "./hook-input.js";
import {
  appendSupervisorControlCommand,
  readClaudeSupervisorEnv,
  readSupervisorHandshake,
  writeSupervisorHandshake,
} from "./supervisor-control.js";

export async function runClaudeSessionStartHook(): Promise<void> {
  try {
    const hook = await readClaudeHookInputIfAny(25);
    const transcriptPath = hook?.transcriptPath;
    if (!transcriptPath) return;

    const sessionId = hook?.sessionId ?? deriveSessionIdFromPath(transcriptPath);

    const supervisor = readClaudeSupervisorEnv();
    if (supervisor) {
      const existing = await readSupervisorHandshake(supervisor.controlDir);
      if (!existing || existing.runId === supervisor.runId) {
        await writeSupervisorHandshake({
          controlDir: supervisor.controlDir,
          handshake: {
            runId: supervisor.runId,
            sessionId,
            transcriptPath,
            ts: new Date().toISOString(),
          },
        });
      }

      // Check for pending reload from previous run (stored in session state)
      if (supervisor.reloadMode === "auto") {
        const state = await readSessionState(sessionId);
        if (state?.pendingReload) {
          // There's a pending reload from a previous supervisor run
          await appendSupervisorControlCommand({
            controlDir: supervisor.controlDir,
            command: {
              ts: new Date().toISOString(),
              cmd: "reload",
              reason: "pending_from_previous_run",
            },
          });
          await updateSessionState(sessionId, { pendingReload: null });
          await appendSessionLog(sessionId, {
            event: "auto_reload",
            result: "requested",
            mode: "auto",
            armedTs: state.pendingReload.ts,
            armedReason: state.pendingReload.reason,
          });
        }
      }
    }

    // Log to new storage only
    await appendSessionLog(sessionId, {
      event: "session_start",
      sessionPath: transcriptPath,
      ...(hook?.hookEventName ? { hookEventName: hook.hookEventName } : {}),
      ...(hook?.cwd ? { cwd: hook.cwd } : {}),
    });
  } catch {
    // Never fail Claude hooks because of EVS logging.
  }
}
