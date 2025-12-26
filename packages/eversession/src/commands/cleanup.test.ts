import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCleanupCommand } from "./cleanup.js";

async function runCleanup(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const program = new Command();
    program.exitOverride();
    registerCleanupCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli cleanup", () => {
  const prevEnv = { EVS_CONFIG_PATH: process.env.EVS_CONFIG_PATH };

  afterEach(() => {
    if (prevEnv.EVS_CONFIG_PATH === undefined) delete process.env.EVS_CONFIG_PATH;
    else process.env.EVS_CONFIG_PATH = prevEnv.EVS_CONFIG_PATH;
  });

  it("dry-run reports stale active record and does not delete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evs-cleanup-"));
    process.env.EVS_CONFIG_PATH = join(dir, "config.json");

    const activeDir = join(dir, "active");
    await mkdir(activeDir, { recursive: true });

    const runId = "run-test-1";
    const recordPath = join(activeDir, `claude-${runId}.json`);
    const controlDir = join(os.tmpdir(), "evs-claude", runId);
    await mkdir(controlDir, { recursive: true });

    await writeFile(
      recordPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          agent: "claude",
          runId,
          pid: 999999,
          controlDir,
          cwd: "/tmp",
          reloadMode: "manual",
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const res = await runCleanup(["cleanup"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Would remove active");
    expect(res.stdout).toContain(recordPath);
    expect(res.stdout).toContain("Would remove tmp");
    expect(res.stdout).toContain(controlDir);

    await expect(readFile(recordPath, "utf8")).resolves.toContain('"runId": "run-test-1"');
    await expect(stat(controlDir)).resolves.toBeDefined();

    // Apply: now delete.
    const applied = await runCleanup(["cleanup", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    expect(applied.stdout).toContain("Removed active");
    expect(applied.stdout).toContain("Removed tmp");

    await expect(readFile(recordPath, "utf8")).rejects.toThrow();
    // Control dir should be gone.
    await expect(stat(controlDir)).rejects.toThrow();
  });

  it("does not remove records for a live pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evs-cleanup-"));
    process.env.EVS_CONFIG_PATH = join(dir, "config.json");

    const activeDir = join(dir, "active");
    await mkdir(activeDir, { recursive: true });

    const runId = `run-live-${Date.now()}`;
    const recordPath = join(activeDir, `claude-${runId}.json`);
    const controlDir = join(os.tmpdir(), "evs-claude", runId);
    await mkdir(controlDir, { recursive: true });

    await writeFile(
      recordPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          agent: "claude",
          runId,
          pid: process.pid,
          controlDir,
          cwd: "/tmp",
          reloadMode: "manual",
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    try {
      const res = await runCleanup(["cleanup", "--apply"]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");
      expect(res.stdout).toContain("Nothing to clean");

      await expect(readFile(recordPath, "utf8")).resolves.toContain('"runId":');
    } finally {
      await rm(controlDir, { recursive: true, force: true });
    }
  });
});
