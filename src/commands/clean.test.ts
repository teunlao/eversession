import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerCleanCommand } from "./clean.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runClean(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerCleanCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli clean", () => {
  it("errors on empty keywords", async () => {
    const path = await writeTempSession("");
    const res = await runClean(["clean", path, "", "--json"]);
    expect(res.exitCode).toBe(2);
    const obj = JSON.parse(res.stdout) as { issues: Array<{ code: string }> };
    expect(obj.issues[0]?.code).toBe("core.clean_missing_keywords");
  });

  it("dry-run removes matching Codex lines and does not rewrite the file", async () => {
    const initial = [
      JSON.stringify({ timestamp: "2025-01-01T00:00:00Z", type: "session_meta", payload: { id: "c1" } }),
      JSON.stringify({
        timestamp: "2025-01-01T00:00:01Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "token=SECRET" }] },
      }),
    ].join("\n") + "\n";
    const path = await writeTempSession(initial);

    const res = await runClean(["clean", path, "token", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as {
      agent: string;
      matched: number;
      wrote: boolean;
      changes: { changes: Array<{ kind: string; line: number }> };
    };
    expect(obj.agent).toBe("codex");
    expect(obj.matched).toBe(1);
    expect(obj.wrote).toBe(false);
    expect(obj.changes.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "delete_line", line: 2 })]),
    );

    const after = await readFile(path, "utf8");
    expect(after).toBe(initial);
  });

  it("dry-run removes matching Claude lines (including string content)", async () => {
    const initial =
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        parentUuid: null,
        message: { role: "assistant", content: "token=SECRET" },
      }) + "\n";
    const path = await writeTempSession(initial);

    const res = await runClean(["clean", path, "token", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; matched: number; wrote: boolean };
    expect(obj.agent).toBe("claude");
    expect(obj.matched).toBe(1);
    expect(obj.wrote).toBe(false);
  });
});
