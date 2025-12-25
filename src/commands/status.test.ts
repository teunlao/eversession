import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "./status.js";

async function runStatus(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerStatusCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

function todayYyyyMmDd(): { yyyy: string; mm: string; dd: string } {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { yyyy: String(d.getFullYear()), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()) };
}

describe("cli status", () => {
  it("prints Codex token gauge and bar from token_count events", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-status-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const id = "22222222-2222-2222-2222-222222222222";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: { type: "token_count", info: null, rate_limits: null },
        }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 22_749 },
              last_token_usage: { total_tokens: 22_749 },
              model_context_window: 258_400,
            },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runStatus([
      "status",
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
      "--threshold",
      "100k",
      "--bar-width",
      "8",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("EVS: Waiting 23k/100k [█▒▒▒▒▒▒▒]\n");
  });

  it("uses EVS project config (codex.autoCompact.threshold) for Codex status", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-status-"));
    const cwd = join(base, "proj");
    await mkdir(join(cwd, ".evs"), { recursive: true });
    await writeFile(
      join(cwd, ".evs", "config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          codex: {
            autoCompact: {
              enabled: true,
              threshold: "20%",
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const id = "44444444-4444-4444-4444-444444444444";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 31_000 },
              last_token_usage: { total_tokens: 31_000 },
              model_context_window: 258_400,
            },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runStatus([
      "status",
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("EVS: Waiting 31k/52k [████▒▒▒▒]\n");
  });

  it("prefers last_token_usage.total_tokens over total_token_usage.total_tokens", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-status-"));
    const cwd = join(base, "proj");
    await mkdir(join(cwd, ".evs"), { recursive: true });
    await writeFile(
      join(cwd, ".evs", "config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          codex: {
            autoCompact: {
              enabled: true,
              threshold: "20%",
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const id = "55555555-5555-5555-5555-555555555555";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 90_000 },
              last_token_usage: { total_tokens: 26_500 },
              model_context_window: 258_400,
            },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runStatus([
      "status",
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("EVS: Waiting 27k/52k [████▒▒▒▒]\n");
  });

  it("uses estimated tokens when token_count is older than the last compaction", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-status-"));
    const cwd = join(base, "proj");
    await mkdir(join(cwd, ".evs"), { recursive: true });
    await writeFile(
      join(cwd, ".evs", "config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          codex: {
            autoCompact: {
              enabled: true,
              threshold: "20%",
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const id = "66666666-6666-6666-6666-666666666666";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: "2025-01-01T00:00:00Z", type: "session_meta", payload: { id, timestamp: "2025-01-01T00:00:00Z", cwd } }),
        JSON.stringify({
          timestamp: "2025-01-01T00:00:01Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 90_000 },
              last_token_usage: { total_tokens: 90_000 },
              model_context_window: 258_400,
            },
            rate_limits: null,
          },
        }),
        JSON.stringify({
          timestamp: "2025-01-01T00:00:10Z",
          type: "compacted",
          payload: { message: "compacted", replacement_history: [] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runStatus([
      "status",
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
      "--bar-width",
      "8",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("EVS: Waiting ~0/52k [▒▒▒▒▒▒▒▒]\n");
  });

  it("auto mode prefers Codex when no Claude execution context exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-status-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const { yyyy, mm, dd } = todayYyyyMmDd();
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const id = "33333333-3333-3333-3333-333333333333";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 110_000 },
              last_token_usage: { total_tokens: 110_000 },
              model_context_window: 258_400,
            },
            rate_limits: null,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runStatus([
      "status",
      "--agent",
      "auto",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
      "--threshold",
      "100k",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("EVS: Over 110k/100k [████████]\n");
  });
});
