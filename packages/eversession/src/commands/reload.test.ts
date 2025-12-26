import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRAND } from "../core/brand.js";
import { parseSupervisorControlCommandLine as parseClaudeControl } from "../integrations/claude/supervisor-control.js";
import { parseSupervisorControlCommandLine as parseCodexControl } from "../integrations/codex/supervisor-control.js";
import { registerReloadCommand } from "./reload.js";

async function runReload(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerReloadCommand(program);
    await program.parseAsync(["node", "evs", ...args]);
    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe("cli reload", () => {
  const prevEnv = {
    claudeControlDir: process.env[BRAND.env.claude.controlDir],
    claudeRunId: process.env[BRAND.env.claude.runId],
    codexControlDir: process.env[BRAND.env.codex.controlDir],
    codexRunId: process.env[BRAND.env.codex.runId],
  };

  afterEach(() => {
    if (prevEnv.claudeControlDir) process.env[BRAND.env.claude.controlDir] = prevEnv.claudeControlDir;
    else delete process.env[BRAND.env.claude.controlDir];

    if (prevEnv.claudeRunId) process.env[BRAND.env.claude.runId] = prevEnv.claudeRunId;
    else delete process.env[BRAND.env.claude.runId];

    if (prevEnv.codexControlDir) process.env[BRAND.env.codex.controlDir] = prevEnv.codexControlDir;
    else delete process.env[BRAND.env.codex.controlDir];

    if (prevEnv.codexRunId) process.env[BRAND.env.codex.runId] = prevEnv.codexRunId;
    else delete process.env[BRAND.env.codex.runId];
  });

  it("errors outside supervisor env", async () => {
    delete process.env[BRAND.env.claude.controlDir];
    delete process.env[BRAND.env.claude.runId];
    delete process.env[BRAND.env.codex.controlDir];
    delete process.env[BRAND.env.codex.runId];

    const res = await runReload(["reload"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("only available inside an EverSession supervisor");
  });

  it("writes reload command for Claude supervisor", async () => {
    const controlDir = await mkdtemp(join(tmpdir(), "evs-reload-claude-"));
    process.env[BRAND.env.claude.controlDir] = controlDir;
    process.env[BRAND.env.claude.runId] = "run-1";

    const res = await runReload(["reload"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const log = await readFile(join(controlDir, "control.jsonl"), "utf8");
    const line = log.trim().split("\n").filter(Boolean).pop();
    expect(line).toBeDefined();
    const cmd = parseClaudeControl(line ?? "");
    expect(cmd?.cmd).toBe("reload");
  });

  it("writes reload command for Codex supervisor", async () => {
    const controlDir = await mkdtemp(join(tmpdir(), "evs-reload-codex-"));
    delete process.env[BRAND.env.claude.controlDir];
    delete process.env[BRAND.env.claude.runId];
    process.env[BRAND.env.codex.controlDir] = controlDir;
    process.env[BRAND.env.codex.runId] = "run-2";

    const res = await runReload(["reload"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const log = await readFile(join(controlDir, "control.jsonl"), "utf8");
    const line = log.trim().split("\n").filter(Boolean).pop();
    expect(line).toBeDefined();
    const cmd = parseCodexControl(line ?? "");
    expect(cmd?.cmd).toBe("reload");
  });
});
