import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendSupervisorControlCommand,
  clearPendingReload,
  controlLogPathForControlDir,
  handshakePathForControlDir,
  parseReloadMode,
  parseSupervisorControlCommandLine,
  pendingReloadPathForControlDir,
  readPendingReload,
  readClaudeSupervisorEnv,
  readSupervisorHandshake,
  writePendingReload,
  writeSupervisorHandshake,
} from "./supervisor-control.js";

describe("integrations/claude/supervisor-control", () => {
  it("parseReloadMode accepts known values only", () => {
    expect(parseReloadMode("manual")).toBe("manual");
    expect(parseReloadMode("auto")).toBe("auto");
    expect(parseReloadMode("off")).toBe("off");
    expect(parseReloadMode("")).toBeUndefined();
    expect(parseReloadMode("  ")).toBeUndefined();
    expect(parseReloadMode("MANUAL")).toBeUndefined();
    expect(parseReloadMode("nope")).toBeUndefined();
  });

  it("readClaudeSupervisorEnv reads env and defaults reloadMode to manual", () => {
    expect(readClaudeSupervisorEnv({})).toBeUndefined();
    expect(readClaudeSupervisorEnv({ EVS_CLAUDE_CONTROL_DIR: "/x", EVS_CLAUDE_RUN_ID: "r" })?.reloadMode).toBe("manual");
    expect(
      readClaudeSupervisorEnv({
        EVS_CLAUDE_CONTROL_DIR: "/x",
        EVS_CLAUDE_RUN_ID: "r",
        EVS_CLAUDE_RELOAD_MODE: "auto",
      })?.reloadMode,
    ).toBe("auto");
    expect(
      readClaudeSupervisorEnv({
        EVS_CLAUDE_CONTROL_DIR: "/x",
        EVS_CLAUDE_RUN_ID: "r",
        EVS_CLAUDE_RELOAD_MODE: "weird",
      })?.reloadMode,
    ).toBe("manual");
  });

  it("handshake/control paths are derived from control dir", () => {
    const dir = "/tmp/evs";
    expect(handshakePathForControlDir(dir)).toBe(path.join(dir, "handshake.json"));
    expect(controlLogPathForControlDir(dir)).toBe(path.join(dir, "control.jsonl"));
    expect(pendingReloadPathForControlDir(dir)).toBe(path.join(dir, "pending-reload.json"));
  });

  it("writeSupervisorHandshake writes and readSupervisorHandshake reads", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "evs-test-"));
    const controlDir = path.join(tmp, "control");
    await fs.mkdir(controlDir, { recursive: true });

    await writeSupervisorHandshake({
      controlDir,
      handshake: {
        runId: "run-1",
        sessionId: "session-1",
        transcriptPath: "/x/session.jsonl",
        ts: new Date().toISOString(),
      },
    });

    const parsed = await readSupervisorHandshake(controlDir);
    expect(parsed).toBeTruthy();
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.sessionId).toBe("session-1");
  });

  it("appendSupervisorControlCommand appends jsonl and parser reads it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "evs-test-"));
    const controlDir = path.join(tmp, "control");
    await fs.mkdir(controlDir, { recursive: true });

    await appendSupervisorControlCommand({
      controlDir,
      command: { ts: new Date().toISOString(), cmd: "reload", reason: "manual" },
    });

    const logPath = controlLogPathForControlDir(controlDir);
    const text = await fs.readFile(logPath, "utf8");
    const line = text.trim().split("\n")[0] ?? "";
    const parsed = parseSupervisorControlCommandLine(line);
    expect(parsed).toBeTruthy();
    expect(parsed?.cmd).toBe("reload");
    expect(parsed?.reason).toBe("manual");
  });

  it("writePendingReload/readPendingReload/clearPendingReload roundtrip", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "evs-test-"));
    const controlDir = path.join(tmp, "control");
    await fs.mkdir(controlDir, { recursive: true });

    expect(await readPendingReload(controlDir)).toBeUndefined();

    await writePendingReload({
      controlDir,
      pending: { ts: new Date().toISOString(), reason: "auto_compact_success" },
    });

    const parsed = await readPendingReload(controlDir);
    expect(parsed).toBeTruthy();
    expect(parsed?.reason).toBe("auto_compact_success");

    await clearPendingReload(controlDir);
    expect(await readPendingReload(controlDir)).toBeUndefined();
  });
});
