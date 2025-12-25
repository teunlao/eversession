import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultEvsConfig } from "../core/project-config.js";
import { registerInstallCommand } from "./install.js";

async function runInstall(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerInstallCommand(program);
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

describe("cli install (evs config defaults)", () => {
  const prevEnv = { EVS_CONFIG_PATH: process.env.EVS_CONFIG_PATH };

  afterEach(() => {
    process.env.EVS_CONFIG_PATH = prevEnv.EVS_CONFIG_PATH;
  });

  it("fills defaults into an existing local .evs/config.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evs-install-config-"));
    process.env.EVS_CONFIG_PATH = join(dir, "global-config.json");

    await mkdir(join(dir, ".evs"), { recursive: true });
    const configPath = join(dir, ".evs", "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + "\n", "utf8");

    const res = await runInstall(["install", "--agent", "claude"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const cfg = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    expect(cfg).toEqual(defaultEvsConfig());
  });

  it("preserves user overrides while filling missing defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evs-install-config-"));
    process.env.EVS_CONFIG_PATH = join(dir, "global-config.json");

    await mkdir(join(dir, ".evs"), { recursive: true });
    const configPath = join(dir, ".evs", "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        { schemaVersion: 1, backup: true, claude: { autoCompact: { enabled: false, threshold: "123k" } } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const res = await runInstall(["install", "--agent", "claude"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const cfg = JSON.parse(await readFile(configPath, "utf8")) as ReturnType<typeof defaultEvsConfig>;
    const expected = defaultEvsConfig();
    expected.backup = true;
    expected.claude.autoCompact.enabled = false;
    expected.claude.autoCompact.threshold = "123k";
    expect(cfg).toEqual(expected);
  });

  it("errors on unknown fields in local config instead of deleting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evs-install-config-"));
    process.env.EVS_CONFIG_PATH = join(dir, "global-config.json");

    await mkdir(join(dir, ".evs"), { recursive: true });
    const configPath = join(dir, ".evs", "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, lol: true }, null, 2) + "\n", "utf8");

    const res = await runInstall(["install", "--agent", "claude"], dir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Unknown field: lol");

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('"lol": true');
  });
});

