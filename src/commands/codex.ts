import { spawn } from "node:child_process";
import type { Command } from "commander";

import { parseDurationMs } from "../core/duration.js";
import { parseTokenThreshold } from "../core/threshold.js";
import { executeCodexSupervisorCommand } from "../integrations/codex/cli-supervisor.js";
import { type CodexAutoCompactAmountMode, runCodexAutoCompactOnce } from "../integrations/codex/auto-compact.js";
import { installCodexNotify, uninstallCodexNotify } from "../integrations/codex/config.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { parseCodexNotifyEvent, resolveCodexStatePath, updateCodexStateFromNotify } from "../integrations/codex/state.js";
import { readCodexSupervisorEnv, readSupervisorHandshake, writeSupervisorHandshake } from "../integrations/codex/supervisor-control.js";
import { isClaudeAutoCompactModel } from "../integrations/claude/auto-compact.js";
import type { ModelType } from "../agents/claude/summary.js";
import { parseCountOrPercent, parseTokensOrPercent } from "../core/spec.js";

function parseNotifyArgs(args: string[]): {
  notificationJson?: string;
  statePath?: string;
  json?: true;
  autoCompact?: true;
  threshold?: string;
  amount?: string;
  amountTokens?: string;
  amountMessages?: string;
  model?: string;
  busyTimeout?: string;
  codexSessionsDir?: string;
} {
  let notificationJson: string | undefined;
  let statePath: string | undefined;
  let json = false;
  let autoCompact = false;
  let threshold: string | undefined;
  let amount: string | undefined;
  let amountTokens: string | undefined;
  let amountMessages: string | undefined;
  let model: string | undefined;
  let busyTimeout: string | undefined;
  let codexSessionsDir: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg) continue;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--auto-compact") {
      autoCompact = true;
      continue;
    }

    if (arg === "--state-path") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        statePath = value;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--state-path=")) {
      const value = arg.slice("--state-path=".length).trim();
      if (value.length > 0) statePath = value;
      continue;
    }

    if (arg === "--threshold") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        threshold = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--threshold=")) {
      const value = arg.slice("--threshold=".length).trim();
      if (value.length > 0) threshold = value;
      continue;
    }

    if (arg === "--amount") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amount = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount=")) {
      const value = arg.slice("--amount=".length).trim();
      if (value.length > 0) amount = value;
      continue;
    }

    if (arg === "--amount-tokens") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amountTokens = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount-tokens=")) {
      const value = arg.slice("--amount-tokens=".length).trim();
      if (value.length > 0) amountTokens = value;
      continue;
    }

    if (arg === "--amount-messages") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amountMessages = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount-messages=")) {
      const value = arg.slice("--amount-messages=".length).trim();
      if (value.length > 0) amountMessages = value;
      continue;
    }

    if (arg === "--model") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        model = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (value.length > 0) model = value;
      continue;
    }

    if (arg === "--busy-timeout") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        busyTimeout = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--busy-timeout=")) {
      const value = arg.slice("--busy-timeout=".length).trim();
      if (value.length > 0) busyTimeout = value;
      continue;
    }

    if (arg === "--codex-sessions-dir") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        codexSessionsDir = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--codex-sessions-dir=")) {
      const value = arg.slice("--codex-sessions-dir=".length).trim();
      if (value.length > 0) codexSessionsDir = value;
      continue;
    }

    if (!notificationJson) {
      notificationJson = arg;
      continue;
    }
  }

  const out: {
    notificationJson?: string;
    statePath?: string;
    json?: true;
    autoCompact?: true;
    threshold?: string;
    amount?: string;
    amountTokens?: string;
    amountMessages?: string;
    model?: string;
    busyTimeout?: string;
    codexSessionsDir?: string;
  } = {};
  if (notificationJson) out.notificationJson = notificationJson;
  if (statePath) out.statePath = statePath;
  if (json) out.json = true;
  if (autoCompact) out.autoCompact = true;
  if (threshold) out.threshold = threshold;
  if (amount) out.amount = amount;
  if (amountTokens) out.amountTokens = amountTokens;
  if (amountMessages) out.amountMessages = amountMessages;
  if (model) out.model = model;
  if (busyTimeout) out.busyTimeout = busyTimeout;
  if (codexSessionsDir) out.codexSessionsDir = codexSessionsDir;
  return out;
}

function spawnDetached(argv: string[]): void {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
  child.unref();
}

async function runCodexNotify(args: string[]): Promise<void> {
  const parsedArgs = parseNotifyArgs(args);
  const notificationJson = parsedArgs.notificationJson;
  if (!notificationJson) {
    process.stderr.write("[evs codex notify] Missing NOTIFICATION_JSON argument.\n");
    process.exitCode = 2;
    return;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(notificationJson);
  } catch {
    process.stderr.write("[evs codex notify] Invalid JSON.\n");
    process.exitCode = 2;
    return;
  }

  const event = parseCodexNotifyEvent(obj);
  if (!event) {
    process.stderr.write("[evs codex notify] Unsupported notification payload.\n");
    process.exitCode = 2;
    return;
  }

  const statePath = resolveCodexStatePath(parsedArgs.statePath);
  await updateCodexStateFromNotify({ statePath, event });

  // If running under an `evs codex` supervisor, write/update handshake for reload/resume.
  const supervisor = readCodexSupervisorEnv();
  if (supervisor) {
    try {
      const existing = await readSupervisorHandshake(supervisor.controlDir);
      if (!existing || existing.runId === supervisor.runId) {
        await writeSupervisorHandshake({
          controlDir: supervisor.controlDir,
          handshake: {
            runId: supervisor.runId,
            threadId: event["thread-id"],
            cwd: event.cwd,
            ts: new Date().toISOString(),
            ...(event["turn-id"] ? { turnId: event["turn-id"] } : {}),
          },
        });
      }
    } catch {
      // Never fail Codex notify hooks because of EVS supervisor handshakes.
    }
  }

  if (parsedArgs.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          type: event.type,
          threadId: event["thread-id"],
          ...(event["turn-id"] ? { turnId: event["turn-id"] } : {}),
          cwd: event.cwd,
        },
        null,
        2,
      ) + "\n",
    );
  }

  if (parsedArgs.autoCompact) {
    const supervisor = readCodexSupervisorEnv();
    // Safety: only do rolling compaction when Codex is supervised by EVS (safe reload boundary).
    if (supervisor) {
      const cwd = event.cwd;
      const sessionId = event["thread-id"];
      const codexSessionsDir = parsedArgs.codexSessionsDir ?? defaultCodexSessionsDir();

      const defaultAmountTokens = "40%";
      const amountTokensRaw = parsedArgs.amountTokens?.trim();
      const amountMessagesRaw = parsedArgs.amountMessages?.trim();
      const legacyAmountRaw = parsedArgs.amount?.trim();
      if (amountTokensRaw && (amountMessagesRaw || legacyAmountRaw)) {
        // Never fail Codex notify hooks because of config errors; just skip auto-compact.
        process.stderr.write("[evs codex notify] Use either --amount-tokens or --amount-messages/--amount (not both).\n");
        process.exitCode = 0;
        return;
      }

      const amountMode: CodexAutoCompactAmountMode =
        amountTokensRaw || (!amountMessagesRaw && !legacyAmountRaw) ? "tokens" : "messages";
      const amountRaw =
        amountTokensRaw ?? (amountMode === "tokens" ? defaultAmountTokens : amountMessagesRaw ?? legacyAmountRaw ?? "35%");
      try {
        if (amountMode === "tokens") parseTokensOrPercent(amountRaw);
        else parseCountOrPercent(amountRaw);
      } catch (err) {
        process.stderr.write(
          `[evs codex notify] Invalid amount (${amountMode}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 0;
        return;
      }
      const modelRaw = parsedArgs.model;
      const model: ModelType = isClaudeAutoCompactModel(modelRaw) ? modelRaw : "haiku";

      let thresholdTokens: number | undefined;
      if (parsedArgs.threshold) {
        try {
          thresholdTokens = parseTokenThreshold(parsedArgs.threshold);
        } catch {
          thresholdTokens = undefined;
        }
      }

      const busyTimeoutMs = parsedArgs.busyTimeout ? parseDurationMs(parsedArgs.busyTimeout) : 10_000;

      const cliPath = process.argv[1];
      if (cliPath) {
        const workerArgs = [
          cliPath,
          "codex",
          "auto-compact",
          "run",
          "--cwd",
          cwd,
          "--session-id",
          sessionId,
          "--codex-sessions-dir",
          codexSessionsDir,
          ...(amountMode === "tokens" ? ["--amount-tokens", amountRaw] : ["--amount-messages", amountRaw]),
          "--model",
          model,
          "--busy-timeout",
          `${busyTimeoutMs}ms`,
        ];
        if (thresholdTokens !== undefined) workerArgs.push("--threshold", String(thresholdTokens));
        spawnDetached(workerArgs);
      }
    }
  }

  process.exitCode = 0;
}

function parseInstallArgs(args: string[]): { force: boolean } {
  let force = false;
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") force = true;
  }
  return { force };
}

async function runCodexInstall(args: string[]): Promise<void> {
  try {
    const parsed = parseInstallArgs(args);
    const res = await installCodexNotify({ force: parsed.force });

    if (res.changed) {
      console.log(`✓ Installed Codex notify for EverSession (${res.configPath}).`);
      console.log("Restart Codex for changes to take effect.");
    } else {
      console.log(`○ Codex notify already configured (${res.configPath}).`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}

async function runCodexUninstall(): Promise<void> {
  try {
    const res = await uninstallCodexNotify({});
    if (res.changed) {
      console.log(`✓ Uninstalled Codex notify for EverSession (${res.configPath}).`);
      console.log("Restart Codex for changes to take effect.");
    } else {
      console.log(`○ No EverSession Codex notify to uninstall (${res.configPath}).`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}

function parseAutoCompactArgs(args: string[]): {
  cwd?: string;
  sessionId?: string;
  threshold?: string;
  amount?: string;
  amountTokens?: string;
  amountMessages?: string;
  model?: string;
  busyTimeout?: string;
  codexSessionsDir?: string;
} {
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let threshold: string | undefined;
  let amount: string | undefined;
  let amountTokens: string | undefined;
  let amountMessages: string | undefined;
  let model: string | undefined;
  let busyTimeout: string | undefined;
  let codexSessionsDir: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg) continue;

    if (arg === "--cwd") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        cwd = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      const value = arg.slice("--cwd=".length).trim();
      if (value.length > 0) cwd = value;
      continue;
    }

    if (arg === "--session-id") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        sessionId = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      const value = arg.slice("--session-id=".length).trim();
      if (value.length > 0) sessionId = value;
      continue;
    }

    if (arg === "--threshold") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        threshold = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--threshold=")) {
      const value = arg.slice("--threshold=".length).trim();
      if (value.length > 0) threshold = value;
      continue;
    }

    if (arg === "--amount") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amount = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount=")) {
      const value = arg.slice("--amount=".length).trim();
      if (value.length > 0) amount = value;
      continue;
    }

    if (arg === "--amount-tokens") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amountTokens = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount-tokens=")) {
      const value = arg.slice("--amount-tokens=".length).trim();
      if (value.length > 0) amountTokens = value;
      continue;
    }

    if (arg === "--amount-messages") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        amountMessages = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--amount-messages=")) {
      const value = arg.slice("--amount-messages=".length).trim();
      if (value.length > 0) amountMessages = value;
      continue;
    }

    if (arg === "--model") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        model = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (value.length > 0) model = value;
      continue;
    }

    if (arg === "--busy-timeout") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        busyTimeout = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--busy-timeout=")) {
      const value = arg.slice("--busy-timeout=".length).trim();
      if (value.length > 0) busyTimeout = value;
      continue;
    }

    if (arg === "--codex-sessions-dir") {
      const value = args[i + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        codexSessionsDir = value.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--codex-sessions-dir=")) {
      const value = arg.slice("--codex-sessions-dir=".length).trim();
      if (value.length > 0) codexSessionsDir = value;
      continue;
    }
  }

  const out: {
    cwd?: string;
    sessionId?: string;
    threshold?: string;
    amount?: string;
    amountTokens?: string;
    amountMessages?: string;
    model?: string;
    busyTimeout?: string;
    codexSessionsDir?: string;
  } = {};
  if (cwd) out.cwd = cwd;
  if (sessionId) out.sessionId = sessionId;
  if (threshold) out.threshold = threshold;
  if (amount) out.amount = amount;
  if (amountTokens) out.amountTokens = amountTokens;
  if (amountMessages) out.amountMessages = amountMessages;
  if (model) out.model = model;
  if (busyTimeout) out.busyTimeout = busyTimeout;
  if (codexSessionsDir) out.codexSessionsDir = codexSessionsDir;
  return out;
}

async function runCodexAutoCompact(args: string[]): Promise<void> {
  const mode = args[0] === "run" ? "run" : "run";
  const rest = args[0] === "run" ? args.slice(1) : args;
  if (mode !== "run") {
    process.stderr.write("[evs codex auto-compact] Only `run` is supported right now.\n");
    process.exitCode = 2;
    return;
  }

  const parsed = parseAutoCompactArgs(rest);
  const cwd = parsed.cwd ?? process.cwd();
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    process.stderr.write("[evs codex auto-compact] Missing --session-id.\n");
    process.exitCode = 2;
    return;
  }

  let thresholdTokens: number | undefined;
  if (parsed.threshold) {
    try {
      thresholdTokens = parseTokenThreshold(parsed.threshold);
    } catch (err) {
      process.stderr.write(`[evs codex auto-compact] Invalid --threshold: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const defaultAmountTokens = "40%";
  const amountTokensRaw = parsed.amountTokens?.trim();
  const amountMessagesRaw = parsed.amountMessages?.trim();
  const legacyAmountRaw = parsed.amount?.trim();
  if (amountTokensRaw && (amountMessagesRaw || legacyAmountRaw)) {
    process.stderr.write("[evs codex auto-compact] Use either --amount-tokens or --amount-messages/--amount (not both).\n");
    process.exitCode = 2;
    return;
  }

  const amountMode: CodexAutoCompactAmountMode =
    amountTokensRaw || (!amountMessagesRaw && !legacyAmountRaw) ? "tokens" : "messages";
  const amountRaw =
    amountTokensRaw ?? (amountMode === "tokens" ? defaultAmountTokens : amountMessagesRaw ?? legacyAmountRaw ?? "35%");
  try {
    if (amountMode === "tokens") parseTokensOrPercent(amountRaw);
    else parseCountOrPercent(amountRaw);
  } catch (err) {
    process.stderr.write(
      `[evs codex auto-compact] Invalid amount (${amountMode}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const modelRaw = parsed.model;
  const model: ModelType = isClaudeAutoCompactModel(modelRaw) ? modelRaw : "haiku";
  const busyTimeoutMs = parseDurationMs(parsed.busyTimeout ?? "10s");
  const codexSessionsDir = parsed.codexSessionsDir ?? defaultCodexSessionsDir();

  const out = await runCodexAutoCompactOnce({
    cwd,
    sessionId,
    codexSessionsDir,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    amountMode,
    amountRaw,
    model,
    busyTimeoutMs,
  });

  process.exitCode =
    out.result === "success" || out.result === "pending_ready" || out.result === "not_triggered" ? 0 : 1;
}

export function registerCodexCommand(program: Command): void {
  program
    .command("codex")
    .description("Run Codex under an EverSession supervisor (enables notify + reload)")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--reload <mode>", "reload mode: manual|auto|off (default: manual)")
    .action(async (opts: { reload?: string }, cmd: Command) => {
      const args = cmd.args.map((a) => String(a));

      // Hook handler: `notify` is invoked by Codex via config.toml or `--config notify=...`.
      if (args[0] === "notify") {
        await runCodexNotify(args.slice(1));
        return;
      }

      if (args[0] === "auto-compact") {
        await runCodexAutoCompact(args.slice(1));
        return;
      }

      if (args[0] === "install") {
        await runCodexInstall(args.slice(1));
        return;
      }

      if (args[0] === "uninstall") {
        await runCodexUninstall();
        return;
      }

      const exitCode = await executeCodexSupervisorCommand({
        reloadFlag: opts.reload,
        args,
        env: process.env,
      });
      process.exitCode = exitCode;
    });
}
