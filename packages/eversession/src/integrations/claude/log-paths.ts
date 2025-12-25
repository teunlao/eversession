import { fileExists } from "../../core/fs.js";
import { deriveSessionIdFromPath, logPathForSession } from "../../core/paths.js";
import { getLogPath } from "./eversession-session-storage.js";

export async function resolveClaudeSessionLogPath(
  sessionPath: string,
): Promise<{ path: string; centralLogPath: string; localLogPath: string } | undefined> {
  const sessionId = deriveSessionIdFromPath(sessionPath);
  const centralLogPath = getLogPath(sessionId);
  const localLogPath = logPathForSession(sessionPath);
  const logPath = (await fileExists(centralLogPath)) ? centralLogPath : localLogPath;
  if (!(await fileExists(logPath))) return undefined;
  return { path: logPath, centralLogPath, localLogPath };
}
