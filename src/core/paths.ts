import * as os from "node:os";
import * as path from "node:path";

import { BRAND } from "./brand.js";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function deriveSessionIdFromPath(sessionPath: string): string {
  const base = path.basename(sessionPath);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

export function logPathForSession(sessionPath: string): string {
  const dir = path.dirname(sessionPath);
  const id = deriveSessionIdFromPath(sessionPath);
  return path.join(dir, `${id}${BRAND.storage.localSessionLogSuffix}`);
}

export function lockPathForSession(sessionPath: string): string {
  const dir = path.dirname(sessionPath);
  const id = deriveSessionIdFromPath(sessionPath);
  return path.join(dir, `${id}${BRAND.storage.localSessionLockSuffix}`);
}
