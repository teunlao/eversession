import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerPinCommand } from "./pin.js";
import { registerPinsCommand } from "./pins.js";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerPinCommand(program);
    registerPinsCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

function cwdHashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

async function writeClaudeProjectSession(params: {
  claudeProjectsDir: string;
  cwd: string;
  uuid: string;
}): Promise<string> {
  const dir = join(params.claudeProjectsDir, cwdHashV2(params.cwd));
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${params.uuid}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: params.uuid,
      timestamp: "2025-12-20T00:00:01Z",
      message: { role: "user", content: "Hello" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: params.uuid,
      timestamp: "2025-12-20T00:00:02Z",
      requestId: "r1",
      message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    }),
  ].join("\n");
  await writeFile(filePath, lines + "\n", "utf8");
  return filePath;
}

async function writeCodexSession(params: {
  codexSessionsDir: string;
  dateDir: { yyyy: string; mm: string; dd: string };
  id: string;
  cwd: string;
}): Promise<string> {
  const dayDir = join(params.codexSessionsDir, params.dateDir.yyyy, params.dateDir.mm, params.dateDir.dd);
  await mkdir(dayDir, { recursive: true });

  const filePath = join(dayDir, `rollout-2025-12-20T00-00-00.000Z-${params.id}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2025-12-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id: params.id, timestamp: "2025-12-20T00:00:00.000Z", cwd: params.cwd },
    }),
    JSON.stringify({ timestamp: "2025-12-20T00:00:01.000Z", type: "message", payload: { role: "user", text: "Yo" } }),
  ].join("\n");
  await writeFile(filePath, lines + "\n", "utf8");
  return filePath;
}

const prevEnv = {
  EVS_CODEX_STATE_PATH: process.env.EVS_CODEX_STATE_PATH,
  EVS_CLAUDE_TRANSCRIPT_PATH: process.env.EVS_CLAUDE_TRANSCRIPT_PATH,
};

beforeEach(async () => {
  vi.useFakeTimers();

  // Avoid reading real user state files from ~/ during tests.
  const envRoot = await mkdtemp(join(tmpdir(), "evs-pin-env-"));
  process.env.EVS_CODEX_STATE_PATH = join(envRoot, "codex-state.json");
  delete process.env.EVS_CLAUDE_TRANSCRIPT_PATH;
});

afterEach(() => {
  vi.useRealTimers();
  process.env.EVS_CODEX_STATE_PATH = prevEnv.EVS_CODEX_STATE_PATH;
  if (prevEnv.EVS_CLAUDE_TRANSCRIPT_PATH) process.env.EVS_CLAUDE_TRANSCRIPT_PATH = prevEnv.EVS_CLAUDE_TRANSCRIPT_PATH;
  else delete process.env.EVS_CLAUDE_TRANSCRIPT_PATH;
});

describe("cli pin / pins", () => {
  it("errors when no ref is provided outside Claude context", async () => {
    // This code path waits briefly for possible Claude hook stdin; use real timers.
    vi.useRealTimers();
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const pinsPath = join(root, "pins.json");

    const res = await runCli(["pin", "oops", "--pins-path", pinsPath]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("pins a Claude session by UUID (project lookup)", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });
    const claudeProjectsDir = join(root, "claude-projects");
    const uuid = "11111111-1111-1111-1111-111111111111";
    const sessionPath = await writeClaudeProjectSession({ claudeProjectsDir, cwd, uuid });
    const pinsPath = join(root, "pins.json");

    const res = await runCli([
      "pin",
      "work",
      uuid,
      "--agent",
      "claude",
      "--cwd",
      cwd,
      "--claude-projects-dir",
      claudeProjectsDir,
      "--pins-path",
      pinsPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const obj = JSON.parse(res.stdout) as { agent: string; sessionId: string; sessionPath: string; name: string };
    expect(obj.name).toBe("work");
    expect(obj.agent).toBe("claude");
    expect(obj.sessionId).toBe(uuid);
    expect(obj.sessionPath).toBe(sessionPath);

    const res2 = await runCli(["pins", "--pins-path", pinsPath, "--json"]);
    expect(res2.exitCode).toBe(0);
    const pins = JSON.parse(res2.stdout) as Array<{ name: string }>;
    expect(pins.map((p) => p.name)).toEqual(["work"]);
  });

  it("pins a Codex session by session id (lookback scan)", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });
    const codexSessionsDir = join(root, "codex-sessions");
    const pinsPath = join(root, "pins.json");
    const id = "c1";
    const sessionPath = await writeCodexSession({
      codexSessionsDir,
      dateDir: { yyyy: "2025", mm: "12", dd: "20" },
      id,
      cwd,
    });

    const res = await runCli([
      "pin",
      "codex",
      id,
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "1",
      "--pins-path",
      pinsPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const obj = JSON.parse(res.stdout) as { agent: string; sessionId: string; sessionPath: string; name: string };
    expect(obj.name).toBe("codex");
    expect(obj.agent).toBe("codex");
    expect(obj.sessionId).toBe(id);
    expect(obj.sessionPath).toBe(sessionPath);
  });

  it("pins a Codex session without a ref when Codex state is present (even if Claude env is set)", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(root, "codex-sessions");
    const pinsPath = join(root, "pins.json");
    const id = "c1";
    const sessionPath = await writeCodexSession({
      codexSessionsDir,
      dateDir: { yyyy: "2025", mm: "12", dd: "20" },
      id,
      cwd,
    });

    // Simulate a stale Claude env leak (this caused wrong pins in Codex).
    const claudeLeak = join(root, "leak.jsonl");
    await writeFile(
      claudeLeak,
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "leak", timestamp: "2025-12-20T00:00:01Z" }) + "\n",
      "utf8",
    );
    process.env.EVS_CLAUDE_TRANSCRIPT_PATH = claudeLeak;

    const statePath = process.env.EVS_CODEX_STATE_PATH;
    if (!statePath) throw new Error("Expected EVS_CODEX_STATE_PATH to be set");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: "2025-12-20T00:00:00Z",
          byCwd: {
            [cwd]: { threadId: id, updatedAt: "2025-12-20T00:00:00Z" },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const res = await runCli([
      "pin",
      "current",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "1",
      "--pins-path",
      pinsPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; sessionId: string; sessionPath: string; name: string };
    expect(obj.name).toBe("current");
    expect(obj.agent).toBe("codex");
    expect(obj.sessionId).toBe(id);
    expect(obj.sessionPath).toBe(sessionPath);
  });

  it("filters pins by agent, query, and date range", async () => {
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const pinsPath = join(root, "pins.json");

    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    // Create a minimal Claude-like file for the path pin (the command only needs detection + filename id).
    const alphaPath = join(root, "alpha.jsonl");
    await writeFile(
      alphaPath,
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "alpha", timestamp: "2025-12-20T00:00:01Z" }) +
        "\n",
      "utf8",
    );
    const res1 = await runCli(["pin", "alpha", alphaPath, "--pins-path", pinsPath, "--json"]);
    expect(res1.exitCode).toBe(0);

    vi.setSystemTime(new Date("2025-12-21T00:00:00Z"));
    await writeFile(
      join(root, "rollout-foo-c1.jsonl"),
      [
        JSON.stringify({ timestamp: "2025-12-21T00:00:00Z", type: "session_meta", payload: { id: "c1" } }),
        JSON.stringify({ timestamp: "2025-12-21T00:00:01Z", type: "message", payload: {} }),
      ].join("\n") + "\n",
      "utf8",
    );
    const res2 = await runCli(["pin", "beta", join(root, "rollout-foo-c1.jsonl"), "--pins-path", pinsPath, "--json"]);
    expect(res2.exitCode).toBe(0);

    const claudeOnly = await runCli(["pins", "--pins-path", pinsPath, "--agent", "claude", "--json"]);
    const claudePins = JSON.parse(claudeOnly.stdout) as Array<{ name: string; agent: string }>;
    expect(claudePins.every((p) => p.agent === "claude")).toBe(true);

    const query = await runCli(["pins", "--pins-path", pinsPath, "--q", "c1", "--json"]);
    const queryPins = JSON.parse(query.stdout) as Array<{ name: string }>;
    expect(queryPins.map((p) => p.name)).toEqual(["beta"]);

    const since = await runCli(["pins", "--pins-path", pinsPath, "--since", "2025-12-21", "--json"]);
    const sincePins = JSON.parse(since.stdout) as Array<{ name: string }>;
    expect(sincePins.map((p) => p.name)).toEqual(["beta"]);
  });

  it("refuses to overwrite an existing pin without --force", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-pin-"));
    const pinsPath = join(root, "pins.json");

    const p1 = join(root, "a.jsonl");
    await writeFile(p1, JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "a", timestamp: "2025-12-20T00:00:01Z" }) + "\n", "utf8");
    const res1 = await runCli(["pin", "same", p1, "--pins-path", pinsPath]);
    expect(res1.exitCode).toBe(0);

    const p2 = join(root, "b.jsonl");
    await writeFile(p2, JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "b", timestamp: "2025-12-20T00:00:01Z" }) + "\n", "utf8");
    const res2 = await runCli(["pin", "same", p2, "--pins-path", pinsPath]);
    expect(res2.exitCode).toBe(2);
    expect(res2.stderr).toContain("Pin already exists");

    // With --force it should overwrite.
    const res3 = await runCli(["pin", "same", p2, "--pins-path", pinsPath, "--force", "--json"]);
    expect(res3.exitCode).toBe(0);
    const obj = JSON.parse(res3.stdout) as { sessionPath: string };
    expect(obj.sessionPath).toBe(p2);

    // Sanity: pins file is valid JSON.
    const raw = await readFile(pinsPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
