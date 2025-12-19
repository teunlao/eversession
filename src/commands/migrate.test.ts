import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerMigrateCommand } from "./migrate.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runMigrate(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerMigrateCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli migrate", () => {
  it("supports dry-run migration from legacy Codex to wrapped", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTempSession(
      [
        JSON.stringify({ id: "conv_legacy", timestamp: ts, instructions: null }),
        JSON.stringify({ type: "message", role: "assistant", content: [] }),
      ].join("\n") + "\n",
    );

    const res = await runMigrate(["migrate", path, "--to", "codex-wrapped", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { wrote: boolean; aborted: boolean; post: { error: number } };
    expect(obj.wrote).toBe(false);
    expect(obj.aborted).toBe(false);
    expect(obj.post.error).toBe(0);
  });

  it("rejects unsupported targets", async () => {
    const path = await writeTempSession(`{"foo":1}\n`);
    const res = await runMigrate(["migrate", path, "--to", "nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Only --to codex-wrapped is supported");
  });
});
