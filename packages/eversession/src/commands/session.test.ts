import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerSessionCommand } from "./session.js";

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
  it("resolves Claude sessions from an explicit .jsonl path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-session-"));
    const id = "11111111-1111-1111-1111-111111111111";
    const sessionPath = join(dir, `${id}.jsonl`);

    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: id,
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "hello" },
      }) + "\n",
      "utf8",
    );

    const res = await runSession(["session", sessionPath]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("agent: claude\n");
    expect(res.stdout).toContain(`id: ${id}\n`);
    expect(res.stdout).toContain(`path: ${resolve(sessionPath)}\n`);
  });

  it("resolves Codex sessions from an explicit .jsonl path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-session-"));
    const sessionPath = join(dir, "t1.jsonl");

    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2025-01-01T00:00:00Z",
          type: "session_meta",
          payload: { id: "t1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
        }),
        JSON.stringify({ timestamp: "2025-01-01T00:00:01Z", type: "message", payload: { role: "user", text: "Yo" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runSession(["session", sessionPath]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("agent: codex\n");
    expect(res.stdout).toContain("id: t1\n");
    expect(res.stdout).toContain(`path: ${resolve(sessionPath)}\n`);
  });

  it("requires a ref outside the supervisor", async () => {
    const res = await runSession(["session"]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Missing session.");
  });
});
