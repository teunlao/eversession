import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Command } from "commander";

import {
  activeRunRecordPath,
  evsActiveRunsDir,
  isEvsControlDirForAgent,
  isPidAlive,
  listActiveRunRecordPaths,
  readActiveRunRecordFile,
  type EvsActiveRunAgent,
} from "../core/active-run-registry.js";
import { fileExists } from "../core/fs.js";

type CleanupFlags = {
  apply?: boolean;
  dryRun?: boolean;
};

type CleanupAction =
  | { kind: "remove_active_record"; path: string; reason: string }
  | { kind: "remove_control_dir"; path: string; reason: string };

function tmpBaseDirForAgent(agent: EvsActiveRunAgent): string {
  return path.join(os.tmpdir(), agent === "claude" ? "evs-claude" : "evs-codex");
}

async function safeRmDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

async function cleanupPlan(): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];

  const recordPaths = await listActiveRunRecordPaths();
  const recordPathSet = new Set(recordPaths.map((p) => path.resolve(p)));

  for (const recordPath of recordPaths) {
    const record = await readActiveRunRecordFile(recordPath);
    if (!record) {
      actions.push({ kind: "remove_active_record", path: recordPath, reason: "invalid_record" });
      continue;
    }

    if (isPidAlive(record.pid)) continue;

    actions.push({ kind: "remove_active_record", path: recordPath, reason: "pid_not_alive" });

    const controlDir = record.controlDir;
    if (isEvsControlDirForAgent(controlDir, record.agent) && (await fileExists(controlDir))) {
      actions.push({ kind: "remove_control_dir", path: controlDir, reason: "pid_not_alive" });
    }
  }

  // Conservative: only remove tmp control dirs when we have high confidence they belong to EVS runs.
  // We currently only treat dirs with a corresponding active record as candidates.
  for (const agent of ["claude", "codex"] as const satisfies EvsActiveRunAgent[]) {
    const base = tmpBaseDirForAgent(agent);
    if (!(await fileExists(base))) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(base);
    } catch {
      continue;
    }

    for (const name of entries) {
      const controlDir = path.join(base, name);
      // Only consider directories that match an active record filename; everything else we leave alone.
      const expectedRecord = path.resolve(activeRunRecordPath(agent, name));
      if (!recordPathSet.has(expectedRecord)) continue;
      // Deletion is handled above when the record is stale.
      // If the record is alive, we keep the directory.
      // If the record is stale, it will be removed by the record-based branch.
      // (No-op here to avoid double-reporting.)
    }
  }

  // De-dupe: record stale logic can add same controlDir multiple times (defensive).
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = `${a.kind}:${path.resolve(a.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function printPlan(actions: CleanupAction[], dryRun: boolean): void {
  const label = dryRun ? "Would remove" : "Removed";
  for (const action of actions) {
    const prefix = action.kind === "remove_active_record" ? "active" : "tmp";
    process.stdout.write(`[evs cleanup] ${label} ${prefix}: ${action.path} (${action.reason})\n`);
  }
}

export function registerCleanupCommand(program: Command): void {
  program
    .command("cleanup")
    .description("Clean stale EVS supervisor artifacts (active registry + tmp control dirs)")
    .option("--apply", "apply changes (default: dry-run)")
    .option("--dry-run", "show what would change (default)")
    .action(async (opts: CleanupFlags) => {
      const apply = opts.apply === true;
      const dryRun = opts.dryRun === true || !apply;

      if (apply && opts.dryRun === true) {
        process.stderr.write("[evs cleanup] Use either --apply or --dry-run (not both).\n");
        process.exitCode = 2;
        return;
      }

      let actions: CleanupAction[];
      try {
        actions = await cleanupPlan();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs cleanup] Error: ${message}\n`);
        process.exitCode = 1;
        return;
      }

      if (actions.length === 0) {
        process.stdout.write("[evs cleanup] Nothing to clean.\n");
        process.exitCode = 0;
        return;
      }

      if (dryRun) {
        printPlan(actions, true);
        process.exitCode = 0;
        return;
      }

      // Apply: remove files/dirs. Keep it safe: only delete under ~/.evs/active and /tmp/evs-* control dirs.
      const activeDir = path.resolve(evsActiveRunsDir()) + path.sep;
      for (const action of actions) {
        const target = path.resolve(action.path);
        if (action.kind === "remove_active_record") {
          if (!target.startsWith(activeDir)) continue;
          await safeUnlink(target);
        } else {
          await safeRmDir(target);
        }
      }

      printPlan(actions, false);
      process.exitCode = 0;
    });
}

