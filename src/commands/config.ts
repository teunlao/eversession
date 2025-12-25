import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Command } from "commander";

import { fileExists } from "../core/fs.js";
import { defaultEvsProjectConfig, evsConfigPathForDir, findEvsConfigPath, loadEvsProjectConfig, writeEvsProjectConfig } from "../core/project-config.js";

async function findOrDefaultConfigPath(cwd: string): Promise<string> {
  const existing = await findEvsConfigPath(cwd);
  if (existing) return existing;
  return evsConfigPathForDir(cwd);
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage EVS project defaults (.evs/config.json)");

  config
    .command("path")
    .description("Print the config path that EVS will use for this directory")
    .action(async () => {
      const configPath = await findOrDefaultConfigPath(process.cwd());
      process.stdout.write(configPath + "\n");
      process.exitCode = 0;
    });

  config
    .command("show")
    .description("Print the resolved config (if present)")
    .action(async () => {
      try {
        const loaded = await loadEvsProjectConfig(process.cwd());
        if (!loaded) {
          process.stderr.write("[evs config show] No config found.\n");
          process.exitCode = 2;
          return;
        }
        process.stdout.write(JSON.stringify(loaded.config, null, 2) + "\n");
        process.exitCode = 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        process.stderr.write(`Error: ${msg}\n`);
        process.exitCode = 1;
      }
    });

  config
    .command("init")
    .description("Create .evs/config.json with sensible defaults")
    .option("-f, --force", "overwrite existing config")
    .action(async (opts: { force?: boolean }) => {
      const configPath = await findOrDefaultConfigPath(process.cwd());
      const exists = await fileExists(configPath);
      if (exists && opts.force !== true) {
        process.stdout.write(`○ Config already exists: ${configPath}\n`);
        process.exitCode = 0;
        return;
      }

      await writeEvsProjectConfig({ configPath, config: defaultEvsProjectConfig() });
      process.stdout.write(`✓ Wrote config: ${configPath}\n`);
      process.exitCode = 0;
    });

  config
    .command("remove")
    .description("Remove the nearest .evs/config.json (if present)")
    .action(async () => {
      const existing = await findEvsConfigPath(process.cwd());
      if (!existing) {
        process.stdout.write("○ No config to remove.\n");
        process.exitCode = 0;
        return;
      }

      await fs.unlink(existing);

      const dir = path.dirname(existing);
      try {
        const entries = await fs.readdir(dir);
        if (entries.length === 0) await fs.rmdir(dir);
      } catch {
        // ignore
      }

      process.stdout.write(`✓ Removed config: ${existing}\n`);
      process.exitCode = 0;
    });
}
