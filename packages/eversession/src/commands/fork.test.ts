import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerForkCommand } from "./fork.js";

function hashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

async function runFork(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerForkCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli fork", () => {
  it("forks a Claude session by UUID and rewrites sessionId", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-fork-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const claudeProjectsDir = join(base, "claude-projects");
    const projectDir = join(claudeProjectsDir, hashV2(cwd));
    await mkdir(projectDir, { recursive: true });

    const oldId = "11111111-1111-1111-1111-111111111111";
    const srcPath = join(projectDir, `${oldId}.jsonl`);
    await writeFile(
      srcPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: oldId,
          cwd,
          timestamp: "2025-01-01T00:00:00Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: oldId,
          cwd,
          timestamp: "2025-01-01T00:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runFork([
      "fork",
      oldId,
      "--agent",
      "claude",
      "--cwd",
      cwd,
      "--claude-projects-dir",
      claudeProjectsDir,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const newId = res.stdout.trim();
    expect(newId).not.toBe(oldId);
    expect(newId).toMatch(/^[0-9a-f-]{36}$/i);

    const dstPath = join(projectDir, `${newId}.jsonl`);
    const text = await readFile(dstPath, "utf8");
    const objs = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const obj of objs) {
      if ("sessionId" in obj) expect(obj.sessionId).toBe(newId);
    }
  });

  it("forks a Codex wrapped session by UUID and rewrites session_meta.payload.id", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-fork-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const oldId = "22222222-2222-2222-2222-222222222222";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${oldId}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: oldId, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "user", content: [] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runFork([
      "fork",
      oldId,
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
    const newId = res.stdout.trim();
    expect(newId).not.toBe(oldId);
    expect(newId).toMatch(/^[0-9a-f-]{36}$/i);

    const dstPath = join(dayDir, `rollout-2025-01-01T00-00-00-${newId}.jsonl`);
    const text = await readFile(dstPath, "utf8");
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const meta = lines.find((l) => l.type === "session_meta") as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const payload =
      meta && typeof meta.payload === "object" && meta.payload !== null
        ? (meta.payload as Record<string, unknown>)
        : undefined;
    expect(payload?.id).toBe(newId);
  });

  it("forks a Codex wrapped session by non-UUID id (filename suffix) and rewrites session_meta.payload.id", async () => {
    const base = await mkdtemp(join(tmpdir(), "evs-fork-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const oldId = "c1";
    const srcPath = join(dayDir, `rollout-2025-01-01T00-00-00-${oldId}.jsonl`);
    const ts = "2025-01-01T00:00:00Z";
    await writeFile(
      srcPath,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: oldId, timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "user", content: [] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runFork([
      "fork",
      oldId,
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
    const newId = res.stdout.trim();
    expect(newId).not.toBe(oldId);
    expect(newId).toMatch(/^[0-9a-f-]{36}$/i);

    const dstPath = join(dayDir, `rollout-2025-01-01T00-00-00-${newId}.jsonl`);
    const text = await readFile(dstPath, "utf8");
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const meta = lines.find((l) => l.type === "session_meta") as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const payload =
      meta && typeof meta.payload === "object" && meta.payload !== null
        ? (meta.payload as Record<string, unknown>)
        : undefined;
    expect(payload?.id).toBe(newId);
  });
});
