import { spawn } from "node:child_process";
import type { Command } from "commander";

import { parseDurationMs } from "../core/duration.js";
import { executeCodexSupervisorCommand } from "../integrations/codex/cli-supervisor.js";
import { type CodexAutoCompactAmountMode, runCodexAutoCompactOnce } from "../integrations/codex/auto-compact.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import {
  parseCodexNotifyEvent,
  resolveCodexStatePath,
  resolveCodexThreadIdForCwd,
  updateCodexStateFromNotify,
} from "../integrations/codex/state.js";
import { readCodexSupervisorEnv, readSupervisorHandshake, writeSupervisorHandshake } from "../integrations/codex/supervisor-control.js";
import { isClaudeAutoCompactModel } from "../integrations/claude/auto-compact.js";
import type { ModelType } from "../agents/claude/summary.js";
import { parseCountOrPercent, parseTokensOrPercent, type TokensOrPercent } from "../core/spec.js";
import { resolveEvsConfigForCwd, type EvsConfig } from "../core/project-config.js";

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

async function tryLoadConfig(cwd: string): Promise<EvsConfig | undefined> {
  try {
    const loaded = await resolveEvsConfigForCwd(cwd);
    return loaded.config;
  } catch {
    return undefined;
  }
}

async function resolveCodexSessionIdForAutoCompact(params: {
  cwd: string;
  codexSessionsDir: string;
}): Promise<string | undefined> {
  const supervisor = readCodexSupervisorEnv();
  if (supervisor) {
    try {
      const hs = await readSupervisorHandshake(supervisor.controlDir);
      if (hs && hs.runId === supervisor.runId && hs.threadId.trim().length > 0) return hs.threadId;
    } catch {
      // ignore handshake errors
    }
  }

  try {
    const statePath = resolveCodexStatePath();
    const fromState = await resolveCodexThreadIdForCwd({ cwd: params.cwd, statePath });
    if (fromState) return fromState;
  } catch {
    // ignore state errors
  }

  try {
    const report = await discoverCodexSessionReport({
      cwd: params.cwd,
      codexSessionsDir: params.codexSessionsDir,
      fallback: true,
      lookbackDays: 14,
      maxCandidates: 200,
      tailLines: 500,
      validate: false,
    });
    if (report.agent === "codex" && report.confidence === "high" && report.session.id) return report.session.id;
  } catch {
    // ignore discovery errors
  }

  return undefined;
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
      const cfg = await tryLoadConfig(event.cwd);
      const cfgCodex = cfg?.codex;
      const cfgAuto = cfgCodex?.autoCompact;
      if (cfgAuto?.enabled === false) {
        process.exitCode = 0;
        return;
      }

      const cwd = event.cwd;
      const sessionId = event["thread-id"];
      const codexSessionsDir = parsedArgs.codexSessionsDir ?? defaultCodexSessionsDir();

      const defaultAmountTokens = "40%";
      const amountTokensCli = parsedArgs.amountTokens?.trim();
      const amountMessagesCli = parsedArgs.amountMessages?.trim();
      const legacyAmountCli = parsedArgs.amount?.trim();
      if (amountTokensCli && (amountMessagesCli || legacyAmountCli)) {
        // Never fail Codex notify hooks because of config errors; just skip auto-compact.
        process.stderr.write("[evs codex notify] Use either --amount-tokens or --amount-messages/--amount (not both).\n");
        process.exitCode = 0;
        return;
      }

      let amountMode: CodexAutoCompactAmountMode;
      let amountRaw: string;
      if (amountTokensCli) {
        amountMode = "tokens";
        amountRaw = amountTokensCli;
      } else if (amountMessagesCli || legacyAmountCli) {
        amountMode = "messages";
        amountRaw = amountMessagesCli ?? legacyAmountCli ?? "35%";
      } else {
        const amountTokensCfg = cfgAuto?.amountTokens?.trim();
        const amountMessagesCfg = cfgAuto?.amountMessages?.trim();
        if (amountTokensCfg) {
          amountMode = "tokens";
          amountRaw = amountTokensCfg;
        } else if (amountMessagesCfg) {
          amountMode = "messages";
          amountRaw = amountMessagesCfg;
        } else {
          amountMode = "tokens";
          amountRaw = defaultAmountTokens;
        }
      }
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
      const modelConfigured = (modelRaw ?? cfgAuto?.model)?.trim();
      const model: ModelType = isClaudeAutoCompactModel(modelConfigured) ? modelConfigured : "haiku";

      const thresholdConfigured = (parsedArgs.threshold ?? cfgAuto?.threshold)?.trim();
      const thresholdArg: string | undefined = (() => {
        if (!thresholdConfigured) return undefined;
        try {
          parseTokensOrPercent(thresholdConfigured);
          return thresholdConfigured;
        } catch {
          return undefined;
        }
      })();

      const busyTimeoutRaw = (parsedArgs.busyTimeout ?? cfgAuto?.busyTimeout)?.trim();
      const busyTimeoutMs = busyTimeoutRaw ? parseDurationMs(busyTimeoutRaw) : 10_000;

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
        if (thresholdArg) workerArgs.push("--threshold", thresholdArg);
        spawnDetached(workerArgs);
      }
    }
  }

  process.exitCode = 0;
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
  const codexSessionsDir = parsed.codexSessionsDir ?? defaultCodexSessionsDir();
  const cfg = await tryLoadConfig(cwd);
  const cfgAuto = cfg?.codex?.autoCompact;

  if (!readCodexSupervisorEnv()) {
    // Safety: never auto-compact without an active EVS supervisor.
    process.exitCode = 0;
    return;
  }

  const sessionId =
    parsed.sessionId ??
    (await resolveCodexSessionIdForAutoCompact({
      cwd,
      codexSessionsDir,
    }));
  if (!sessionId) {
    process.stderr.write("[evs codex auto-compact] Missing --session-id.\n");
    process.exitCode = 2;
    return;
  }

  let threshold: TokensOrPercent | undefined;
  const thresholdRaw = parsed.threshold?.trim() ?? cfgAuto?.threshold?.trim();
  if (thresholdRaw) {
    try {
      threshold = parseTokensOrPercent(thresholdRaw);
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

  const amountTokensCfg = cfgAuto?.amountTokens?.trim();
  const amountMessagesCfg = cfgAuto?.amountMessages?.trim();

  let amountMode: CodexAutoCompactAmountMode;
  let amountRaw: string;

  if (amountTokensRaw) {
    amountMode = "tokens";
    amountRaw = amountTokensRaw;
  } else if (amountMessagesRaw || legacyAmountRaw) {
    amountMode = "messages";
    amountRaw = amountMessagesRaw ?? legacyAmountRaw ?? "35%";
  } else if (amountTokensCfg) {
    amountMode = "tokens";
    amountRaw = amountTokensCfg;
  } else if (amountMessagesCfg) {
    amountMode = "messages";
    amountRaw = amountMessagesCfg;
  } else {
    amountMode = "tokens";
    amountRaw = defaultAmountTokens;
  }
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
  const modelRaw = parsed.model?.trim() ?? cfgAuto?.model?.trim();
  const model: ModelType = isClaudeAutoCompactModel(modelRaw) ? modelRaw : "haiku";
  const busyTimeoutMs = parseDurationMs(parsed.busyTimeout?.trim() ?? cfgAuto?.busyTimeout?.trim() ?? "10s");
  const backup = cfgAuto?.backup ?? cfg?.backup ?? false;

  const out = await runCodexAutoCompactOnce({
    cwd,
    sessionId,
    codexSessionsDir,
    ...(threshold ? { threshold } : {}),
    amountMode,
    amountRaw,
    model,
    busyTimeoutMs,
    backup,
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

      const cfg = await tryLoadConfig(process.cwd());
      const reloadFlag = opts.reload ?? cfg?.codex?.reload;
      const exitCode = await executeCodexSupervisorCommand({
        reloadFlag,
        args,
        env: process.env,
      });
      process.exitCode = exitCode;
    });
}
