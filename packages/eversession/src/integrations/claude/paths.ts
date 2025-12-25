import * as os from "node:os";
import * as path from "node:path";

import { BRAND } from "../../core/brand.js";

export const CLAUDE_HOME_DIR = path.join(os.homedir(), ".claude");

export function claudeEversessionBaseDir(): string {
  return path.join(CLAUDE_HOME_DIR, BRAND.storage.claudeBaseDirName);
}

export function defaultClaudeProjectsDir(): string {
  return path.join(CLAUDE_HOME_DIR, "projects");
}

export function defaultClaudeLocalBin(): string {
  return path.join(CLAUDE_HOME_DIR, "local", "claude");
}

export function claudeSettingsPathForCwd(cwd: string): string {
  return path.join(cwd, ".claude", "settings.json");
}

export function claudeGlobalSettingsPath(): string {
  return path.join(CLAUDE_HOME_DIR, "settings.json");
}

export function claudeProjectHashFromTranscriptPath(transcriptPath: string): string | undefined {
  // ~/.claude/projects/<projectHash>/<uuid>.jsonl
  const dir = path.dirname(transcriptPath);
  const hash = path.basename(dir);
  return hash.trim().length > 0 ? hash : undefined;
}
