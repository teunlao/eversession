import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { fileExists } from "../../core/fs.js";
import { defaultClaudeLocalBin } from "./paths.js";

export function isPathLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("~") || trimmed.startsWith(".") || trimmed.includes("/") || trimmed.includes("\\");
}

export async function findExecutableOnPath(bin: string, envPath: string | undefined): Promise<string | undefined> {
  if (isPathLike(bin)) return undefined;
  const pathValue = envPath ?? "";
  const dirs = pathValue
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function defaultClaudeBin(): Promise<string> {
  const envBin = process.env.EVS_CLAUDE_BIN?.trim();
  if (envBin && envBin.length > 0) return envBin;

  const local = defaultClaudeLocalBin();
  if (await fileExists(local)) return local;

  return "claude";
}
