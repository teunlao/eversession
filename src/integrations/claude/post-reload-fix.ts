import { fixClaudeSession } from "../../agents/claude/fix.js";
import { parseClaudeSession } from "../../agents/claude/session.js";
import { writeFileAtomic } from "../../core/fs.js";
import { stringifyJsonl } from "../../core/jsonl.js";
import { deriveSessionIdFromPath } from "../../core/paths.js";
import { appendSessionLog, cleanupOldBackups, createSessionBackup } from "./eversession-session-storage.js";

export type PostReloadFixResult = {
  fixed: boolean;
  changes: number;
  backupPath?: string | undefined;
};

/**
 * Fix session issues before Claude restarts.
 * This handles:
 * - Race condition where Claude writes entries with stale parentUuids after compact
 * - Thinking block order violations (API would reject)
 * - Orphan tool results (Claude ignores but why keep garbage)
 * - API error messages (safe to remove)
 *
 * Does NOT remove orphan tool_uses (might be false positives).
 */
export async function fixSessionBeforeReload(
  sessionPath: string,
  opts?: { noBackup?: boolean },
): Promise<PostReloadFixResult> {
  const { session } = await parseClaudeSession(sessionPath);
  if (!session) {
    return { fixed: false, changes: 0 };
  }

  // Full fix - everything except orphan tool_uses (risky false positives)
  const { nextValues, changes } = fixClaudeSession(session, {
    repairBrokenParentUuids: true,
    fixThinkingBlockOrder: true,
    removeOrphanToolResults: true,
    removeApiErrorMessages: true,
    removeOrphanToolUses: false, // Keep - might be false positives
  });

  const changesCount = changes.changes.length;
  if (changesCount === 0) {
    return { fixed: false, changes: 0 };
  }

  // Create backup before writing
  let backupPath: string | undefined;
  if (!opts?.noBackup) {
    const sessionId = deriveSessionIdFromPath(sessionPath);
    backupPath = await createSessionBackup(sessionId, sessionPath);
    await cleanupOldBackups(sessionId, 10);
  }

  // Write fixed session
  await writeFileAtomic(sessionPath, stringifyJsonl(nextValues));

  // Log to EverSession session log
  const sessionId = deriveSessionIdFromPath(sessionPath);
  await appendSessionLog(sessionId, {
    event: "pre_reload_fix",
    sessionPath,
    changes: changesCount,
    backupPath,
    reasons: changes.changes.slice(0, 10).map((c) => c.reason),
  });

  return { fixed: true, changes: changesCount, backupPath };
}
