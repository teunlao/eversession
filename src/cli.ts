#!/usr/bin/env node
import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerAutoCompactCommand } from "./commands/auto-compact.js";
import { registerClaudeSupervisorCommand } from "./commands/claude.js";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerForkCommand } from "./commands/fork.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerLogCommand } from "./commands/log.js";
import { registerPinCommand } from "./commands/pin.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerSessionStartCommand } from "./commands/session-start.js";
import { registerStatuslineCommand } from "./commands/statusline.js";
import { registerUninstallCommand } from "./commands/uninstall.js";

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
program.name("evs").description("EverSession (supervisor-first auto-compaction for Claude Code + Codex)").version("0.1.0");

// Public CLI
registerClaudeSupervisorCommand(program);
registerCodexCommand(program);
registerInstallCommand(program);
registerUninstallCommand(program);
registerConfigCommand(program);
registerSessionCommand(program);
registerLogCommand(program);
registerAnalyzeCommand(program);
registerLintCommand(program);
registerCompactCommand(program);
registerRemoveCommand(program);
registerForkCommand(program);
registerPinCommand(program);

// Internal (hidden) commands used by hooks/statusline/supervisors
registerAutoCompactCommand(program);
registerSessionStartCommand(program);
registerStatuslineCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
