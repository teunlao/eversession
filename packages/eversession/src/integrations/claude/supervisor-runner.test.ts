import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { appendSupervisorControlCommand, writeSupervisorHandshake } from "./supervisor-control.js";
import { runClaudeSupervisorRunner } from "./supervisor-runner.js";

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
  // Polling is fine here; file is tiny and this is a test.
  while (Date.now() < deadline) {
    const lines = await readLines(filePath);
    if (lines.length >= minLines) return lines;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await readLines(filePath);
}

describe("integrations/claude/supervisor-runner", () => {
  it("restarts child on reload command using handshake session id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "evs-test-"));
    const controlDir = path.join(tmp, "control");
    await fs.mkdir(controlDir, { recursive: true });

    const counterPath = path.join(tmp, "starts.jsonl");
    const fakeClaudePath = path.join(tmp, "fake-claude.mjs");

    await fs.writeFile(
      fakeClaudePath,
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

    const runnerPromise = runClaudeSupervisorRunner({
      bin: process.execPath,
      initialArgs: [fakeClaudePath],
      resumeArgs: (sessionId) => [fakeClaudePath, "--resume", sessionId],
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
        sessionId: "session-1",
        transcriptPath: "/tmp/session-1.jsonl",
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
    expect(records[1]?.args).toEqual(["--resume", "session-1"]);
    expect(records[2]?.args).toEqual(["--resume", "session-1"]);
  });
});
