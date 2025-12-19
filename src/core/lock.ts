import * as fs from "node:fs/promises";

import { sleepMs } from "./sleep.js";

export type LockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

async function tryCreateLock(lockPath: string, payload: string): Promise<LockHandle | undefined> {
  try {
    const fh = await fs.open(lockPath, "wx");
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
    return {
      lockPath,
      release: async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EEXIST") return undefined;
    throw err;
  }
}

export async function acquireLockWithWait(
  lockPath: string,
  options: { timeoutMs: number; initialDelayMs?: number; maxDelayMs?: number },
): Promise<LockHandle | undefined> {
  const timeoutMs = options.timeoutMs;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1000;

  const started = Date.now();
  let delay = initialDelayMs;

  while (Date.now() - started <= timeoutMs) {
    const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    const handle = await tryCreateLock(lockPath, payload);
    if (handle) return handle;

    await sleepMs(delay);
    delay = Math.min(maxDelayMs, Math.floor(delay * 1.5));
  }

  return undefined;
}

