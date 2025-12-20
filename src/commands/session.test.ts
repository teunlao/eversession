import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerSessionCommand } from "./session.js";

function hashV2(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

async function runSession(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerSessionCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli session", () => {
  it("prefers lastActivity timestamp over mtime for Claude sessions", async () => {
    const base = await mkdtemp(join(tmpdir(), "context-reactor-session-"));
    const cwd = join(base, "my.project");
    await mkdir(cwd, { recursive: true });

    const claudeProjectsDir = join(base, "claude-projects");
    const projectDir = join(claudeProjectsDir, hashV2(cwd));
    await mkdir(projectDir, { recursive: true });

    const idA = "11111111-1111-1111-1111-111111111111";
    const idB = "22222222-2222-2222-2222-222222222222";
    const fileA = join(projectDir, `${idA}.jsonl`);
    const fileB = join(projectDir, `${idB}.jsonl`);

    await writeFile(
      fileA,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: idA,
          cwd,
          timestamp: "2025-01-01T00:00:00Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: idA,
          cwd,
          timestamp: "2025-01-01T00:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await writeFile(
      fileB,
      [
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: null,
          sessionId: idB,
          cwd,
          timestamp: "2025-01-02T00:00:00Z",
          message: { role: "user", content: "newer" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Make fileA newer by mtime to ensure we pick fileB by lastActivity instead.
    const now = new Date();
    await utimes(fileA, now, now);
    await utimes(fileB, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));

    const res = await runSession([
      "session",
      "--agent",
      "claude",
      "--cwd",
      cwd,
      "--claude-projects-dir",
      claudeProjectsDir,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; session: { path: string; id?: string } };
    expect(obj.agent).toBe("claude");
    expect(obj.session.path).toBe(fileB);
    expect(obj.session.id).toBe(idB);
  });

  it("resolves Claude sessions by --session-id", async () => {
    const base = await mkdtemp(join(tmpdir(), "context-reactor-session-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const claudeProjectsDir = join(base, "claude-projects");
    const projectDir = join(claudeProjectsDir, hashV2(cwd));
    await mkdir(projectDir, { recursive: true });

    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const file = join(projectDir, `${id}.jsonl`);
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: id,
        cwd,
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "hello" },
      }) + "\n",
      "utf8",
    );

    const res = await runSession([
      "session",
      "--agent",
      "claude",
      "--cwd",
      cwd,
      "--session-id",
      id,
      "--claude-projects-dir",
      claudeProjectsDir,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; session: { path: string; id?: string } };
    expect(obj.agent).toBe("claude");
    expect(obj.session.path).toBe(file);
    expect(obj.session.id).toBe(id);
  });

  it("selects Codex rollout sessions by session_meta.payload.cwd", async () => {
    const base = await mkdtemp(join(tmpdir(), "context-reactor-session-"));
    const cwd = join(base, "proj");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(base, "codex-sessions");
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dayDir = join(codexSessionsDir, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const ts = "2025-01-01T00:00:00Z";
    const good = join(dayDir, "rollout-2025-01-01T00-00-00-c1.jsonl");
    const other = join(dayDir, "rollout-2025-01-01T00-00-00-c2.jsonl");

    await writeFile(
      good,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c1", timestamp: ts, cwd } }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "user", content: [] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await writeFile(
      other,
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c2", timestamp: ts, cwd: "/other" } }),
        JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "message", role: "user", content: [] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runSession([
      "session",
      "--agent",
      "codex",
      "--cwd",
      cwd,
      "--codex-sessions-dir",
      codexSessionsDir,
      "--lookback-days",
      "30",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; session: { path: string } };
    expect(obj.agent).toBe("codex");
    expect(obj.session.path).toBe(good);
  });
});
