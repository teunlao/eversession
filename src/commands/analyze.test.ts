import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerAnalyzeCommand } from "./analyze.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const p = join(dir, "session.jsonl");
  await writeFile(p, text, "utf8");
  return p;
}

async function runAnalyze(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as any);
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as any);

  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const program = new Command();
    program.exitOverride();
    registerAnalyzeCommand(program);
    await program.parseAsync(["node", "cr", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli analyze", () => {
  it("includes message token count for Claude sessions", async () => {
    const session = [
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "u1",
        snapshot: { messageId: "u1", trackedFileBackups: {}, timestamp: "2025-12-16T00:00:00Z" },
        isSnapshotUpdate: false,
      }),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: "2025-12-16T00:00:01Z",
        message: { role: "user", content: "Hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s1",
        timestamp: "2025-12-16T00:00:02Z",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      }),
    ].join("\n") + "\n";
    const path = await writeTempSession(session);

    const res = await runAnalyze(["analyze", path, "--json"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const obj = JSON.parse(res.stdout) as { agent: string; messageTokens: number; messageTokensScope: string };
    expect(obj.agent).toBe("claude");
    expect(typeof obj.messageTokens).toBe("number");
    expect(obj.messageTokens).toBeGreaterThanOrEqual(0);
    expect(obj.messageTokensScope).toContain("Messages");
  });
});

