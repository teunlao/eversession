import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerDiffCommand } from "./diff.js";

async function writeTemp(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runDiff(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerDiffCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli diff", () => {
  it("returns exitCode=1 and JSON changes when files differ", async () => {
    const a = await writeTemp(`{"a":1}\n{"b":2}\n`);
    const b = await writeTemp(`{"a":1}\n{"b":3}\n`);

    const res = await runDiff(["diff", b, "--against", a, "--json"]);
    expect(res.exitCode).toBe(1);
    const obj = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(obj.hasChanges).toBe(true);
    expect(obj.summary).toEqual({ equal: 1, insert: 1, delete: 1 });
  });

  it("returns exitCode=0 when files are identical", async () => {
    const a = await writeTemp(`{"a":1}\n`);
    const b = await writeTemp(`{"a":1}\n`);

    const res = await runDiff(["diff", b, "--against", a, "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(obj.hasChanges).toBe(false);
  });
});
