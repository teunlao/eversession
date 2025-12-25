import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isJsonObject } from "../../core/json.js";
import { claudeGlobalSettingsPath, claudeSettingsPathForCwd } from "./paths.js";

export const GLOBAL_CLAUDE_SETTINGS_PATH = claudeGlobalSettingsPath();

export function resolveClaudeSettingsPath(opts: { global: boolean; cwd: string }): string {
  if (opts.global) return GLOBAL_CLAUDE_SETTINGS_PATH;
  return claudeSettingsPathForCwd(opts.cwd);
}

export async function loadClaudeSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(settingsPath, "utf-8");
    const parsed: unknown = JSON.parse(content) as unknown;
    if (!isJsonObject(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export async function saveClaudeSettings(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  // Create backup first.
  try {
    const existing = await fs.readFile(settingsPath, "utf-8");
    await fs.writeFile(`${settingsPath}.backup`, existing);
  } catch {
    // No existing file to backup.
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}
