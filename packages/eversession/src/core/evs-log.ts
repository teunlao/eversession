import * as fs from "node:fs/promises";

export type EvsLogEvent = Record<string, unknown>;

export async function appendEvsLogLine(logPath: string, event: EvsLogEvent): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  await fs.appendFile(logPath, line, "utf8");
}
