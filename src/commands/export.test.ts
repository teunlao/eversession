import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerExportCommand } from "./export.js";

async function writeTempSession(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "context-reactor-cli-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, text, "utf8");
  return path;
}

async function runExport(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerExportCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli export", () => {
  it("validates --format", async () => {
    const path = await writeTempSession(`{"foo":1}\n`);
    const res = await runExport(["export", path, "--format", "nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("export --format must be one of");
  });

  it("exports Claude assistant string content as JSON", async () => {
    const path = await writeTempSession(
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        parentUuid: null,
        message: { role: "assistant", content: "hello from string" },
      }) + "\n",
    );

    const res = await runExport(["export", path, "--format", "json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as {
      agent: string;
      items: Array<{ kind: string; role: string; text: string; line: number }>;
    };
    expect(obj.agent).toBe("claude");
    expect(obj.items).toEqual([{ kind: "message", role: "assistant", text: "hello from string", line: 1 }]);
  });

  it("exports Codex wrapped message items as JSON", async () => {
    const path = await writeTempSession(
      [
        JSON.stringify({ timestamp: "2025-01-01T00:00:00Z", type: "session_meta", payload: { id: "c1" } }),
        JSON.stringify({
          timestamp: "2025-01-01T00:00:01Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
    );

    const res = await runExport(["export", path, "--format", "json"]);
    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout) as {
      agent: string;
      format: string;
      items: Array<{ kind: string; role: string; text: string; line: number }>;
    };
    expect(obj.agent).toBe("codex");
    expect(obj.format).toBe("wrapped");
    expect(obj.items).toEqual([{ kind: "message", role: "assistant", text: "hello", line: 2 }]);
  });
});
