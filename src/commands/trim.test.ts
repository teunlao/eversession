import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerTrimCommand } from "./trim.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runTrim(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerTrimCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli trim", () => {
  it("dry-run trims Codex wrapped sessions", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTempSession(
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c1", timestamp: ts, cwd: "/tmp" } }),
        JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [] } }),
        JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
      ].join("\n") + "\n",
    );

    const res = await runTrim(["trim", path, "1", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; wrote: boolean; changes: { changes: Array<{ kind: string; line: number }> } };
    expect(obj.agent).toBe("codex");
    expect(obj.wrote).toBe(false);
    expect(obj.changes.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "delete_line", line: 2 })]));
  });

  it("dry-run trims Claude sessions and relinks parents", async () => {
    const path = await writeTempSession(
      [
        JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: "ok" } }),
      ].join("\n") + "\n",
    );

    const res = await runTrim(["trim", path, "1", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; wrote: boolean; changes: { changes: Array<{ kind: string }> } };
    expect(obj.agent).toBe("claude");
    expect(obj.wrote).toBe(false);
    expect(obj.changes.changes.some((c) => c.kind === "delete_line")).toBe(true);
  });
});
