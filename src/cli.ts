#!/usr/bin/env node
import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerAutoCompactCommand } from "./commands/auto-compact.js";
import { registerClaudeSupervisorCommand } from "./commands/claude.js";
import { registerCleanCommand } from "./commands/clean.js";
import { registerCleanupCommand } from "./commands/cleanup.js";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerDetectCommand } from "./commands/detect.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerExportCommand } from "./commands/export.js";
import { registerFixCommand } from "./commands/fix.js";
import { registerForkCommand } from "./commands/fork.js";
import { registerHookEnvCommand } from "./commands/hook-env.js";
import { registerHooksCommand } from "./commands/hooks.js";
import { registerInfoCommand } from "./commands/info.js";
import { registerLogCommand } from "./commands/log.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerPinCommand } from "./commands/pin.js";
import { registerPinsCommand } from "./commands/pins.js";
import { registerReloadCommand } from "./commands/reload.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerSessionStartCommand } from "./commands/session-start.js";
import { registerStatuslineCommand } from "./commands/statusline.js";
import { registerStatuslineStatsCommand } from "./commands/statusline-stats.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStripNoiseCommand } from "./commands/strip-noise.js";
import { registerTrimCommand } from "./commands/trim.js";
import { registerValidateCommand } from "./commands/validate.js";

function hasErrorCode(err: unknown): err is { code: unknown } {
  return err !== null && typeof err === "object" && "code" in err;
}

function installEpipeHandlers(): void {
  const handle = (err: unknown): void => {
    const code = hasErrorCode(err) ? String(err.code) : undefined;
    if (code === "EPIPE") {
      // Downstream consumer closed the pipe (e.g. `evs ... --json | head`).
      // Treat as successful early termination and exit quietly.
      process.exit(0);
    }
  };

  process.stdout.on("error", handle);
  process.stderr.on("error", handle);
}

installEpipeHandlers();

const program = new Command();
program.enablePositionalOptions();
program.passThroughOptions();
program.name("evs").description("EverSession (progressive session compaction for Claude Code)").version("0.1.0");

registerSessionCommand(program);
registerDetectCommand(program);
registerValidateCommand(program);
registerAnalyzeCommand(program);
registerFixCommand(program);
registerCompactCommand(program);
registerConfigCommand(program);
registerCodexCommand(program);
registerCleanCommand(program);
registerExportCommand(program);
registerDiffCommand(program);
registerMigrateCommand(program);
registerStripNoiseCommand(program);
registerTrimCommand(program);
registerRemoveCommand(program);
registerHooksCommand(program);
registerInfoCommand(program);
registerAutoCompactCommand(program);
registerHookEnvCommand(program);
registerOpenCommand(program);
registerLogCommand(program);
registerStatuslineCommand(program);
registerStatuslineStatsCommand(program);
registerStatusCommand(program);
registerSessionStartCommand(program);
registerReloadCommand(program);
registerClaudeSupervisorCommand(program);
registerCleanupCommand(program);
registerForkCommand(program);
registerPinCommand(program);
registerPinsCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
