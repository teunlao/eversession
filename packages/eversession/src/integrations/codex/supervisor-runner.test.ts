import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { appendSupervisorControlCommand, writeSupervisorHandshake } from "./supervisor-control.js";
import { runCodexSupervisorRunner } from "./supervisor-runner.js";

async function readLines(filePath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function waitForMinLines(filePath: string, minLines: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readLines(filePath);
    if (lines.length >= minLines) return lines;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await readLines(filePath);
}

describe("integrations/codex/supervisor-runner", () => {
  it("restarts child on reload command using handshake thread id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "evs-test-"));
    const controlDir = path.join(tmp, "control");
    await fs.mkdir(controlDir, { recursive: true });

    const counterPath = path.join(tmp, "starts.jsonl");
    const fakeCodexPath = path.join(tmp, "fake-codex.mjs");

    await fs.writeFile(
      fakeCodexPath,
      [
        "import fs from 'node:fs';",
        "const out = process.env.COUNTER_PATH;",
        "fs.appendFileSync(out, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const abort = new AbortController();
    const runId = "run-1";

    const runnerPromise = runCodexSupervisorRunner({
      bin: process.execPath,
      initialArgs: [fakeCodexPath],
      resumeArgs: (threadId) => [fakeCodexPath, "resume", threadId],
      env: { ...process.env, COUNTER_PATH: counterPath },
      controlDir,
      runId,
      reloadMode: "manual",
      pollIntervalMs: 50,
      handshakeTimeoutMs: 2000,
      restartTimeoutMs: 2000,
      signal: abort.signal,
    });

    const first = await waitForMinLines(counterPath, 1, 5000);
    expect(first.length).toBeGreaterThanOrEqual(1);

    await writeSupervisorHandshake({
      controlDir,
      handshake: {
        runId,
        threadId: "thread-1",
        cwd: "/tmp",
        ts: new Date().toISOString(),
      },
    });

    await appendSupervisorControlCommand({
      controlDir,
      command: { ts: new Date().toISOString(), cmd: "reload", reason: "manual" },
    });

    const second = await waitForMinLines(counterPath, 2, 5000);
    expect(second.length).toBeGreaterThanOrEqual(2);

    await appendSupervisorControlCommand({
      controlDir,
      command: { ts: new Date().toISOString(), cmd: "reload", reason: "manual" },
    });

    const third = await waitForMinLines(counterPath, 3, 5000);
    expect(third.length).toBeGreaterThanOrEqual(3);

    abort.abort();
    const res = await runnerPromise;
    expect(res.exitCode).toBe(0);

    const records = third.map((line) => JSON.parse(line) as { args: unknown });
    expect(records[0]?.args).toEqual([]);
    expect(records[1]?.args).toEqual(["resume", "thread-1"]);
    expect(records[2]?.args).toEqual(["resume", "thread-1"]);
  });
});
