import * as fs from "node:fs/promises";

import { sleepMs } from "./sleep.js";

export async function waitForStableFile(
  filePath: string,
  options: { timeoutMs: number; stableWindowMs?: number; pollMs?: number },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs;
  const stableWindowMs = options.stableWindowMs ?? 750;
  const pollMs = options.pollMs ?? 150;

  const started = Date.now();
  let lastKey: string | undefined;
  let stableSince: number | undefined;

  while (Date.now() - started <= timeoutMs) {
    let st: { mtimeMs: number; size: number };
    try {
      const s = await fs.stat(filePath);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      await sleepMs(pollMs);
      continue;
    }

    const key = `${st.mtimeMs}:${st.size}`;
    if (key === lastKey) {
      if (stableSince === undefined) stableSince = Date.now();
      if (Date.now() - stableSince >= stableWindowMs) return true;
    } else {
      lastKey = key;
      stableSince = undefined;
    }

    await sleepMs(pollMs);
  }

  return false;
}
