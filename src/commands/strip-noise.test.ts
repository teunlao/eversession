import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerStripNoiseCommand } from "./strip-noise.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runStripNoise(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerStripNoiseCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
  } finally {
    const code = process.exitCode ?? 0;
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: code };
  }
}

describe("cli strip-noise", () => {
  it("dry-run drops Codex noise lines", async () => {
    const ts = "2025-01-01T00:00:00Z";
    const path = await writeTempSession(
      [
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "c1", timestamp: ts, cwd: "/tmp" } }),
        JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "user_message", text: "hi" } }),
        JSON.stringify({ timestamp: ts, type: "turn_context", payload: { sandbox_policy: { type: "danger" } } }),
        JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
      ].join("\n") + "\n",
    );

    const res = await runStripNoise(["strip-noise", path, "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as { agent: string; wrote: boolean; changes: { changes: Array<{ kind: string; line: number }> } };
    expect(obj.agent).toBe("codex");
    expect(obj.wrote).toBe(false);
    expect(obj.changes.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "delete_line", line: 2 }),
        expect.objectContaining({ kind: "delete_line", line: 3 }),
      ]),
    );
  });

  it("rejects non-Codex sessions", async () => {
    const path = await writeTempSession(
      JSON.stringify({ type: "assistant", uuid: "u1", parentUuid: null, message: { role: "assistant", content: "hi" } }) +
        "\n",
    );
    const res = await runStripNoise(["strip-noise", path, "--json"]);
    expect(res.exitCode).toBe(2);
    const obj = JSON.parse(res.stdout) as { issues: Array<{ code: string }> };
    expect(obj.issues[0]?.code).toBe("core.strip_noise_requires_codex");
  });
});
