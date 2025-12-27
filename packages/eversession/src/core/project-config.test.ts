import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveEvsConfigForCwd } from "./project-config.js";

describe("core/project-config", () => {
  const prevEnv = { EVS_CONFIG_PATH: process.env.EVS_CONFIG_PATH };

  afterEach(() => {
    if (prevEnv.EVS_CONFIG_PATH === undefined) delete process.env.EVS_CONFIG_PATH;
    else process.env.EVS_CONFIG_PATH = prevEnv.EVS_CONFIG_PATH;
  });

  it("does not treat the global config path as a discovered local config", async () => {
    const root = await mkdtemp(join(tmpdir(), "evs-project-config-"));
    try {
      const globalPath = join(root, ".evs", "config.json");
      await mkdir(join(root, ".evs"), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ schemaVersion: 1, backup: true }, null, 2) + "\n", "utf8");

      process.env.EVS_CONFIG_PATH = globalPath;

      const projectDir = join(root, "project");
      await mkdir(projectDir, { recursive: true });

      const resolved = await resolveEvsConfigForCwd(projectDir);

      expect(resolved.files.global.path).toBe(globalPath);
      expect(resolved.files.local.discovered).toBe(false);
      expect(resolved.files.local.path).toBe(join(projectDir, ".evs", "config.json"));
      expect(resolved.config.backup).toBe(true);
      expect(resolved.sourceByPath.backup).toBe("global");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

