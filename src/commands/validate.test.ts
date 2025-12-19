import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerValidateCommand } from "./validate.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runValidate(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerValidateCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli validate", () => {
  it("returns exitCode=0 for a valid Codex wrapped session", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTempSession(
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c1", timestamp: ts, cwd: "/tmp" } }),
        JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [] } }),
      ].join("\n") + "\n",
    );

    const res = await runValidate(["validate", path, "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { issues: unknown[] };
    expect(obj.issues).toEqual([]);
  });

  it("returns exitCode=1 when validation finds errors", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTempSession(
      JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [] } }) + "\n",
    );

    const res = await runValidate(["validate", path, "--json"]);
    expect(res.exitCode).toBe(1);
    const obj = JSON.parse(res.stdout) as { issues: Array<{ code: string; severity: string }> };
    expect(obj.issues.some((i) => i.code === "codex.missing_session_meta" && i.severity === "error")).toBe(true);
  });

  it("returns exitCode=2 for unknown formats", async () => {
    const path = await writeTempSession(`{"foo":1}\n`);
    const res = await runValidate(["validate", path, "--json"]);
    expect(res.exitCode).toBe(2);
    const obj = JSON.parse(res.stdout) as { issues: Array<{ code: string }> };
    expect(obj.issues[0]?.code).toBe("core.unknown_format");
  });
});
