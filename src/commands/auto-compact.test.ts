import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getLogPath, getSessionDir } from "../integrations/claude/eversession-session-storage.js";
import { registerAutoCompactCommand } from "./auto-compact.js";

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerAutoCompactCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli auto-compact", () => {
  const prevEnv = {
    EVS_CLAUDE_CONTROL_DIR: process.env.EVS_CLAUDE_CONTROL_DIR,
    EVS_CLAUDE_RUN_ID: process.env.EVS_CLAUDE_RUN_ID,
    EVS_CLAUDE_RELOAD_MODE: process.env.EVS_CLAUDE_RELOAD_MODE,
  };

  afterEach(() => {
    process.env.EVS_CLAUDE_CONTROL_DIR = prevEnv.EVS_CLAUDE_CONTROL_DIR;
    process.env.EVS_CLAUDE_RUN_ID = prevEnv.EVS_CLAUDE_RUN_ID;
    process.env.EVS_CLAUDE_RELOAD_MODE = prevEnv.EVS_CLAUDE_RELOAD_MODE;
  });

  it("infers session path from supervisor handshake and defaults from .claude/settings.json", async () => {
    const prevCwd = process.cwd();

    const root = await mkdtemp(join(tmpdir(), "evs-claude-auto-compact-cli-"));
    const projectDir = join(root, "repo");
    await fs.mkdir(join(projectDir, ".claude"), { recursive: true });

    await writeFile(
      join(projectDir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "evs auto-compact start --threshold 150k --amount-tokens 30% --model haiku --busy-timeout 10s",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    const ts = "2025-12-20T00:00:00.000Z";
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId,
          timestamp: ts,
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId,
          timestamp: ts,
          message: { role: "assistant", content: "ok" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const controlDir = join(root, "control");
    await fs.mkdir(controlDir, { recursive: true });
    process.env.EVS_CLAUDE_CONTROL_DIR = controlDir;
    process.env.EVS_CLAUDE_RUN_ID = "run-1";
    process.env.EVS_CLAUDE_RELOAD_MODE = "manual";
    await writeFile(
      join(controlDir, "handshake.json"),
      JSON.stringify({ runId: "run-1", sessionId, transcriptPath, ts: new Date().toISOString() }, null, 2),
      "utf8",
    );

    try {
      process.chdir(projectDir);
      const res = await runCli(["auto-compact", "run"]);
      expect(res.exitCode).toBe(0);

      const raw = await fs.readFile(getLogPath(sessionId), "utf8");
      const lines = raw.trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
      expect(last.result).toBe("not_triggered");
      expect(last.threshold).toBe(150_000);
      expect(last.amountMode).toBe("tokens");
      expect(last.amount).toBe("30%");
    } finally {
      process.chdir(prevCwd);
      await rm(getSessionDir(sessionId), { recursive: true, force: true });
    }
  });
});

