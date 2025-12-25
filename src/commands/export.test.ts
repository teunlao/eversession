import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("discovers active Codex session when id is omitted", async () => {
    const prevEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      EVS_CODEX_STATE_PATH: process.env.EVS_CODEX_STATE_PATH,
      EVS_CLAUDE_TRANSCRIPT_PATH: process.env.EVS_CLAUDE_TRANSCRIPT_PATH,
    };
    const prevCwd = process.cwd();

    const root = await mkdtemp(join(tmpdir(), "evs-export-codex-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "evs-export-cwd-"));

    try {
      process.env.CODEX_HOME = root;
      process.env.EVS_CODEX_STATE_PATH = join(root, "codex-state.json");
      delete process.env.EVS_CLAUDE_TRANSCRIPT_PATH;

      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dayDir = join(root, "sessions", yyyy, mm, dd);
      await mkdir(dayDir, { recursive: true });

      const sessionId = "11111111-1111-1111-1111-111111111111";
      const transcriptPath = join(dayDir, `rollout-test-${sessionId}.jsonl`);

      process.chdir(cwd);
      const activeCwd = process.cwd();

      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2025-01-01T00:00:00Z",
            type: "session_meta",
            payload: { id: sessionId, cwd: activeCwd },
          }),
          JSON.stringify({
            timestamp: "2025-01-01T00:00:01Z",
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const res = await runExport(["export", "--format", "json"]);
      expect(res.exitCode).toBe(0);

      const obj = JSON.parse(res.stdout) as {
        agent: string;
        items: Array<{ kind: string; role: string; text: string; line: number }>;
      };
      expect(obj.agent).toBe("codex");
      expect(obj.items).toEqual([{ kind: "message", role: "assistant", text: "hello", line: 2 }]);
    } finally {
      process.chdir(prevCwd);
      if (prevEnv.CODEX_HOME) process.env.CODEX_HOME = prevEnv.CODEX_HOME;
      else delete process.env.CODEX_HOME;
      if (prevEnv.EVS_CODEX_STATE_PATH) process.env.EVS_CODEX_STATE_PATH = prevEnv.EVS_CODEX_STATE_PATH;
      else delete process.env.EVS_CODEX_STATE_PATH;
      if (prevEnv.EVS_CLAUDE_TRANSCRIPT_PATH) process.env.EVS_CLAUDE_TRANSCRIPT_PATH = prevEnv.EVS_CLAUDE_TRANSCRIPT_PATH;
      else delete process.env.EVS_CLAUDE_TRANSCRIPT_PATH;
    }
  });
});
