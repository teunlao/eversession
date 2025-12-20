import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerStatuslineCommand } from "./statusline.js";

async function runStatusline(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const spyLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map((a) => String(a)).join(" ") + "\n");
  });
  const spyConsoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrChunks.push(args.map((a) => String(a)).join(" ") + "\n");
  });

  const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(cwd);

  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const program = new Command();
    program.exitOverride();
    registerStatuslineCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyLog.mockRestore();
    spyConsoleError.mockRestore();
    spyCwd.mockRestore();
  }
}

describe("cli statusline uninstall", () => {
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

    const res = await runStatusline(["statusline", "uninstall"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Uninstalled EverSession status line");

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

    const res = await runStatusline(["statusline", "uninstall"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("No EverSession status line to uninstall");

    const after = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after).toEqual(initial);
  });
});
