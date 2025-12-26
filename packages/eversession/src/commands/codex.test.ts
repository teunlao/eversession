import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogPath, getSessionDir } from "../integrations/claude/eversession-session-storage.js";
import { resolveCodexConfigPath } from "../integrations/codex/config.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { registerCodexCommand } from "./codex.js";
import { registerInstallCommand } from "./install.js";
import { registerUninstallCommand } from "./uninstall.js";

async function runCodexCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    program.enablePositionalOptions();
    program.passThroughOptions();
    program.exitOverride();
    registerCodexCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

async function runInstallCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerInstallCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

async function runUninstallCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    registerUninstallCommand(program);
    await program.parseAsync(["node", "evs", ...args]);

    const exitCode = process.exitCode ?? 0;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

async function writeCodexSession(params: {
  codexSessionsDir: string;
  dateDir: { yyyy: string; mm: string; dd: string };
  id: string;
  cwd: string;
}): Promise<string> {
  const dayDir = join(params.codexSessionsDir, params.dateDir.yyyy, params.dateDir.mm, params.dateDir.dd);
  await mkdir(dayDir, { recursive: true });

  const filePath = join(dayDir, `rollout-2025-12-20T00-00-00.000Z-${params.id}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2025-12-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id: params.id, timestamp: "2025-12-20T00:00:00.000Z", cwd: params.cwd },
    }),
    JSON.stringify({ timestamp: "2025-12-20T00:00:01.000Z", type: "message", payload: { role: "user", text: "Yo" } }),
  ].join("\n");
  await writeFile(filePath, lines + "\n", "utf8");
  return filePath;
}

describe("cli codex notify", () => {
  const prevEnv = { statePath: process.env.EVS_CODEX_STATE_PATH };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.EVS_CODEX_STATE_PATH = prevEnv.statePath;
  });

  it("writes codex state and enables discovery by thread-id", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-"));
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });

    const codexSessionsDir = join(root, "codex-sessions");
    const statePath = join(root, "codex-state.json");
    process.env.EVS_CODEX_STATE_PATH = statePath;

    const threadId = "t1";
    // Make the rollout's cwd different to prove state-based discovery works even when cwd-hash matching fails.
    await writeCodexSession({
      codexSessionsDir,
      dateDir: { yyyy: "2025", mm: "12", dd: "20" },
      id: threadId,
      cwd: join(root, "other"),
    });

    const before = await discoverCodexSessionReport({
      cwd,
      codexSessionsDir,
      fallback: false,
      lookbackDays: 1,
      maxCandidates: 50,
      tailLines: 50,
      validate: false,
    });
    expect(before.agent).toBe("unknown");

    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": threadId,
      "turn-id": "42",
      cwd,
      "input-messages": ["hi"],
      "last-assistant-message": "ok",
    });

    const res = await runCodexCli(["codex", "notify", payload, "--state-path", statePath]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");

    const stateRaw = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number; byCwd?: unknown };
    expect(stateRaw.schemaVersion).toBe(1);
    expect(typeof stateRaw.byCwd).toBe("object");

    const after = await discoverCodexSessionReport({
      cwd,
      codexSessionsDir,
      fallback: false,
      lookbackDays: 1,
      maxCandidates: 50,
      tailLines: 50,
      validate: false,
    });
    expect(after.agent).toBe("codex");
    if (after.agent !== "codex") throw new Error("Expected codex report");
    expect(after.confidence).toBe("high");
    expect(after.session.id).toBe(threadId);
  });
});

describe("cli install/uninstall (codex notify)", () => {
  const prevEnv = { CODEX_HOME: process.env.CODEX_HOME, EVS_CONFIG_PATH: process.env.EVS_CONFIG_PATH };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevEnv.CODEX_HOME;

    if (prevEnv.EVS_CONFIG_PATH === undefined) delete process.env.EVS_CONFIG_PATH;
    else process.env.EVS_CONFIG_PATH = prevEnv.EVS_CONFIG_PATH;
  });

  it("installs Codex notify into an empty config.toml", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-config-"));
    process.env.CODEX_HOME = root;
    process.env.EVS_CONFIG_PATH = join(root, "evs-config.json");

    const res = await runInstallCli(["install", "--agent", "codex", "--global"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const configPath = resolveCodexConfigPath({ CODEX_HOME: root });
    const config = await readFile(configPath, "utf8");
    expect(config).toContain('notify = ["evs", "codex", "notify"]');
  });

  it("errors on unsupported components for Codex", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-config-"));
    process.env.CODEX_HOME = root;
    process.env.EVS_CONFIG_PATH = join(root, "evs-config.json");

    const res = await runInstallCli(["install", "--agent", "codex", "--hooks", "--global"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Unsupported component(s) for codex");

    const configPath = resolveCodexConfigPath({ CODEX_HOME: root });
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("inserts notify before the first table header", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-config-"));
    process.env.CODEX_HOME = root;
    process.env.EVS_CONFIG_PATH = join(root, "evs-config.json");

    const configPath = resolveCodexConfigPath({ CODEX_HOME: root });
    await mkdir(join(root), { recursive: true });
    await writeFile(
      configPath,
      ['model = "gpt-5.1"', "", "[features]", "web_search_request = true", ""].join("\n"),
      "utf8",
    );

    const res = await runInstallCli(["install", "--agent", "codex", "--global"]);
    expect(res.exitCode).toBe(0);

    const config = await readFile(configPath, "utf8");
    const modelIndex = config.indexOf('model = "gpt-5.1"');
    const notifyIndex = config.indexOf('notify = ["evs", "codex", "notify"]');
    const featuresIndex = config.indexOf("[features]");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(notifyIndex).toBeGreaterThanOrEqual(0);
    expect(featuresIndex).toBeGreaterThanOrEqual(0);
    expect(notifyIndex).toBeLessThan(featuresIndex);
  });

  it("refuses to overwrite an existing notify config without --force", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-config-"));
    process.env.CODEX_HOME = root;
    process.env.EVS_CONFIG_PATH = join(root, "evs-config.json");

    const configPath = resolveCodexConfigPath({ CODEX_HOME: root });
    await mkdir(join(root), { recursive: true });
    await writeFile(configPath, 'notify = ["python3", "/tmp/notify.py"]\n', "utf8");

    const res = await runInstallCli(["install", "--agent", "codex", "--global"]);
    expect(res.exitCode).toBe(1);

    const config = await readFile(configPath, "utf8");
    expect(config).toContain('notify = ["python3", "/tmp/notify.py"]');

    const forced = await runInstallCli(["install", "--agent", "codex", "--force", "--global"]);
    expect(forced.exitCode).toBe(0);

    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain('notify = ["evs", "codex", "notify"]');
  });

  it("uninstalls EVS notify when present", async () => {
    vi.setSystemTime(new Date("2025-12-20T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "evs-codex-config-"));
    process.env.CODEX_HOME = root;
    process.env.EVS_CONFIG_PATH = join(root, "evs-config.json");

    const configPath = resolveCodexConfigPath({ CODEX_HOME: root });
    await mkdir(join(root), { recursive: true });
    await writeFile(configPath, 'notify = ["evs", "codex", "notify"]\nmodel = "gpt-5.1"\n', "utf8");

    const res = await runUninstallCli(["uninstall", "--agent", "codex"]);
    expect(res.exitCode).toBe(0);

    const updated = await readFile(configPath, "utf8");
    expect(updated).not.toContain('notify = ["evs", "codex", "notify"]');
    expect(updated).toContain('model = "gpt-5.1"');
  });
});

describe("cli codex auto-compact", () => {
  const prevEnv = {
    EVS_CODEX_CONTROL_DIR: process.env.EVS_CODEX_CONTROL_DIR,
    EVS_CODEX_RUN_ID: process.env.EVS_CODEX_RUN_ID,
    EVS_CODEX_RELOAD_MODE: process.env.EVS_CODEX_RELOAD_MODE,
  };

  afterEach(() => {
    if (prevEnv.EVS_CODEX_CONTROL_DIR === undefined) delete process.env.EVS_CODEX_CONTROL_DIR;
    else process.env.EVS_CODEX_CONTROL_DIR = prevEnv.EVS_CODEX_CONTROL_DIR;

    if (prevEnv.EVS_CODEX_RUN_ID === undefined) delete process.env.EVS_CODEX_RUN_ID;
    else process.env.EVS_CODEX_RUN_ID = prevEnv.EVS_CODEX_RUN_ID;

    if (prevEnv.EVS_CODEX_RELOAD_MODE === undefined) delete process.env.EVS_CODEX_RELOAD_MODE;
    else process.env.EVS_CODEX_RELOAD_MODE = prevEnv.EVS_CODEX_RELOAD_MODE;
  });

  it("infers session id + defaults from supervisor/config when omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "evs-codex-auto-compact-cli-"));
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });

    await mkdir(join(cwd, ".evs"), { recursive: true });
    await writeFile(
      join(cwd, ".evs", "config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          codex: {
            reload: "manual",
            autoCompact: { enabled: false, threshold: "150k", amountTokens: "30%", model: "sonnet", busyTimeout: "5s" },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const codexSessionsDir = join(root, "codex-sessions");
    const threadId = randomUUID();
    await writeCodexSession({
      codexSessionsDir,
      dateDir: { yyyy: "2025", mm: "12", dd: "20" },
      id: threadId,
      cwd,
    });

    const controlDir = join(root, "control");
    await mkdir(controlDir, { recursive: true });
    process.env.EVS_CODEX_CONTROL_DIR = controlDir;
    process.env.EVS_CODEX_RUN_ID = "run-1";
    process.env.EVS_CODEX_RELOAD_MODE = "manual";
    await writeFile(
      join(controlDir, "handshake.json"),
      JSON.stringify({ runId: "run-1", threadId, cwd, ts: new Date().toISOString() }, null, 2),
      "utf8",
    );

    try {
      const res = await runCodexCli([
        "codex",
        "auto-compact",
        "run",
        "--cwd",
        cwd,
        "--codex-sessions-dir",
        codexSessionsDir,
      ]);
      expect(res.exitCode).toBe(0);

      const raw = await readFile(getLogPath(threadId), "utf8");
      const lines = raw.trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
      expect(last.result).toBe("not_triggered");
      expect(last.threshold).toBe(150_000);
      expect(last.amountMode).toBe("tokens");
      expect(last.amount).toBe("30%");
    } finally {
      await rm(getSessionDir(threadId), { recursive: true, force: true });
    }
  });
});
