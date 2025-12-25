import type { Command } from "commander";

import { executeClaudeSupervisorCommand } from "../integrations/claude/cli-supervisor.js";

export function registerClaudeSupervisorCommand(program: Command): void {
  program
    .command("claude")
    .description("Run Claude Code under an EverSession supervisor (enables 1-command reload)")
    // We want `evs claude <anything claude supports>` to work without changes, now and in the future.
    // Therefore: parse only `--reload`, and pass through all other flags/args to the real `claude`.
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--reload <mode>", "reload mode: manual|auto|off (default: manual)")
    .action(async (opts: { reload?: string }, cmd: Command) => {
      const exitCode = await executeClaudeSupervisorCommand({
        reloadFlag: opts.reload,
        args: cmd.args.map((a) => String(a)),
        env: process.env,
      });
      process.exitCode = exitCode;
    });
}
