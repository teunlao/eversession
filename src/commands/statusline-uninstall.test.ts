import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerUninstallCommand } from "./uninstall.js";

async function runUninstall(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

  const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(cwd);

  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const program = new Command();
    program.exitOverride();
    registerUninstallCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
    spyCwd.mockRestore();
  }
}

describe("cli uninstall --agent claude --statusline", () => {
  it("removes EverSession statusLine from project settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-statusline-"));
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "evs statusline", padding: 0 } }, null, 2),
      "utf8",
    );

    const res = await runUninstall(["uninstall", "--agent", "claude", "--statusline"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("[evs uninstall] Claude statusline: Uninstalled");

    const updated = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect("statusLine" in updated).toBe(false);
  });

  it("does not remove non-EverSession statusLine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-statusline-"));
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");

    const initial = { statusLine: { type: "command", command: "echo hi" }, other: 123 };
    await writeFile(settingsPath, JSON.stringify(initial, null, 2), "utf8");

    const res = await runUninstall(["uninstall", "--agent", "claude", "--statusline"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("[evs uninstall] Claude statusline: Not installed");

    const after = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after).toEqual(initial);
  });
});
