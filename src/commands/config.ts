import type { Command } from "commander";

import { resolveEvsConfigForCwd } from "../core/project-config.js";

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("EVS config");

  config
    .command("show")
    .description("Show resolved config (default + ~/.evs/config.json + <project>/.evs/config.json)")
    .action(async () => {
      try {
        const resolved = await resolveEvsConfigForCwd(process.cwd());
        process.stdout.write(
          JSON.stringify(
            {
              config: resolved.config,
              files: resolved.files,
              sourceByPath: resolved.sourceByPath,
            },
            null,
            2,
          ) + "\n",
        );
        process.exitCode = 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        process.stderr.write(`Error: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}
