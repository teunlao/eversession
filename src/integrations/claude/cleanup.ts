import {
  cleanupOldSessions,
  getSessionLastActivityMs,
  listSessions,
  readSessionState,
} from "./eversession-session-storage.js";

type ClaudeCleanupOptions = {
  maxAge: string;
  dryRun?: boolean;
  list?: boolean;
};

export async function runClaudeCleanupCommand(opts: ClaudeCleanupOptions): Promise<void> {
  const maxAgeDays = Number(opts.maxAge);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    console.error("Error: --max-age must be a non-negative number");
    process.exitCode = 1;
    return;
  }

  if (opts.list) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No EverSession session data found.");
      return;
    }

    console.log(`Found ${sessions.length} session(s):\n`);
    const now = Date.now();

    for (const sessionId of sessions) {
      try {
        const lastActivityMs = await getSessionLastActivityMs(sessionId);
        const ageDays = lastActivityMs ? (now - lastActivityMs) / (24 * 60 * 60 * 1000) : NaN;
        const state = await readSessionState(sessionId);
        const hasPending = state?.pendingReload ? " [pending reload]" : "";
        const hasCompact = state?.lastCompact ? ` [last compact: ${state.lastCompact.model}]` : "";
        console.log(
          `  ${sessionId} (${Number.isFinite(ageDays) ? ageDays.toFixed(1) : "unknown"} days old)${hasPending}${hasCompact}`,
        );
      } catch {
        console.log(`  ${sessionId} (unknown age)`);
      }
    }

    return;
  }

  if (opts.dryRun) {
    const sessions = await listSessions();
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let wouldDelete = 0;

    for (const sessionId of sessions) {
      try {
        const lastActivityMs = await getSessionLastActivityMs(sessionId);
        if (!lastActivityMs) continue;
        const age = now - lastActivityMs;
        if (age >= maxAgeMs) {
          const ageDays = age / (24 * 60 * 60 * 1000);
          console.log(`Would delete: ${sessionId} (${ageDays.toFixed(1)} days old)`);
          wouldDelete++;
        }
      } catch {
        // ignore
      }
    }

    if (wouldDelete === 0) {
      console.log(`No sessions older than ${maxAgeDays} days.`);
    } else {
      console.log(`\nWould delete ${wouldDelete} session(s).`);
    }

    return;
  }

  const result = await cleanupOldSessions(maxAgeDays);

  if (result.deleted === 0 && result.errors === 0) {
    console.log(`No sessions older than ${maxAgeDays} days.`);
  } else if (result.errors === 0) {
    console.log(`Deleted ${result.deleted} session(s) older than ${maxAgeDays} days.`);
  } else {
    console.log(`Deleted ${result.deleted} session(s), ${result.errors} error(s).`);
  }
}
