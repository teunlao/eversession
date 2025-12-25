import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { deriveSessionIdFromPath } from "../../core/paths.js";
import { getBackupsDir } from "./eversession-session-storage.js";

export function getClaudeCentralBackupsDir(sessionPath: string): string {
  const sessionId = deriveSessionIdFromPath(sessionPath);
  return getBackupsDir(sessionId);
}

export async function resolveClaudeCentralBackup(sessionPath: string): Promise<string | undefined> {
  const backupsDir = getClaudeCentralBackupsDir(sessionPath);

  try {
    const entries = await readdir(backupsDir, { withFileTypes: true });
    const backups = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort();

    const last = backups[backups.length - 1];
    return last ? join(backupsDir, last) : undefined;
  } catch {
    return undefined;
  }
}
