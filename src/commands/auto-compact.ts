import type { Command } from "commander";

import { spawn } from "node:child_process";

import {
  isClaudeAutoCompactModel,
  runClaudeAutoCompactOnce,
  type AutoCompactAmountMode,
  type AutoCompactRunOptions,
} from "../integrations/claude/auto-compact.js";
import { resolveClaudeActiveCwd } from "../integrations/claude/context.js";
import { resolveClaudeSessionPathFromInputs } from "../integrations/claude/active-session.js";

import { parseTokenThreshold } from "../core/threshold.js";
import { parseDurationMs } from "../core/duration.js";
import { readClaudeHookInputIfAny } from "../integrations/claude/hook-input.js";
import { deriveSessionIdFromPath } from "../core/paths.js";
import { appendSupervisorControlCommand, readClaudeSupervisorEnv } from "../integrations/claude/supervisor-control.js";
import { appendSessionLog, readSessionState, updateSessionState } from "../integrations/claude/eversession-session-storage.js";

function spawnDetached(argv: string[]): void {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
  child.unref();
}

export function registerAutoCompactCommand(program: Command): void {
  const cmd = program.command("auto-compact").description("Auto compaction orchestrator for Claude Code hooks");

  cmd
    .command("start")
    .description("Start auto-compact in the background (intended for Claude hooks)")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .option("--session <path>", "Claude session JSONL path (overrides --cwd resolution)")
    .option("--threshold <n>", "token threshold (e.g. 140k)", "140k")
    .option("--amount <n|%>", "amount to compact (default: 25%)", "25%")
    .option("--amount-messages <n|%>", "amount to compact by messages (alias for --amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (e.g. 25% or 30k)")
    .option("--keep-last <n>", "keep last N messages (integer)")
    .option("--model <model>", "haiku|sonnet|opus (default: haiku)", "haiku")
    .option("--busy-timeout <duration>", "max time to wait on locks/file stability (default: 10s)", "10s")
    .option("--notify", "send OS notification on successful compact")
    .action(
      async (opts: {
        cwd?: string;
        session?: string;
        threshold: string;
        amount: string;
        amountMessages?: string;
        amountTokens?: string;
        keepLast?: string;
        model: string;
        busyTimeout: string;
        notify?: boolean;
      }) => {
      const hook = await readClaudeHookInputIfAny(25);
      const cwd = resolveClaudeActiveCwd(opts.cwd ?? hook?.cwd);
      const thresholdTokens = parseTokenThreshold(opts.threshold);
      const model = isClaudeAutoCompactModel(opts.model) ? opts.model : "haiku";
      const busyTimeoutMs = parseDurationMs(opts.busyTimeout);

      const amountTokensRaw = opts.amountTokens?.trim();
      const amountMessagesRaw = opts.amountMessages?.trim();
      if (amountTokensRaw && amountMessagesRaw) {
        process.stderr.write("[evs auto-compact] Use either --amount-messages or --amount-tokens (not both).\n");
        process.exitCode = 2;
        return;
      }
      if (amountTokensRaw && opts.keepLast && opts.keepLast.trim().length > 0) {
        process.stderr.write("[evs auto-compact] --amount-tokens cannot be combined with --keep-last.\n");
        process.exitCode = 2;
        return;
      }

      const amountMode: AutoCompactAmountMode = amountTokensRaw ? "tokens" : "messages";
      const amountRaw = amountTokensRaw ?? amountMessagesRaw ?? opts.amount;

      const sessionPath = await resolveClaudeSessionPathFromInputs({
        cwd,
        ...(hook?.transcriptPath ? { hookPath: hook.transcriptPath } : {}),
        ...(opts.session ? { explicitPath: opts.session } : {}),
      });
      if (!sessionPath) {
        // No session to work with
        process.exitCode = 1;
        return;
      }

      const sessionId = deriveSessionIdFromPath(sessionPath);
      const supervisor = readClaudeSupervisorEnv();

      // Check for pending reload from session state (set by previous compact)
      if (supervisor && supervisor.reloadMode === "auto") {
        const state = await readSessionState(sessionId);
        if (state?.pendingReload) {
          try {
            await appendSupervisorControlCommand({
              controlDir: supervisor.controlDir,
              command: { ts: new Date().toISOString(), cmd: "reload", reason: "auto_deferred_until_next_stop" },
            });
            await updateSessionState(sessionId, { pendingReload: null });
            await appendSessionLog(sessionId, {
              event: "auto_reload",
              sessionPath,
              result: "requested",
              mode: "auto",
              armedTs: state.pendingReload.ts,
              armedReason: state.pendingReload.reason,
            });
            return;
          } catch {
            // Best-effort: if we cannot request reload, keep the pending marker for the next hook.
          }
        }
      }

      await appendSessionLog(sessionId, {
        event: "auto_compact_start",
        sessionPath,
        threshold: thresholdTokens,
        amountMode,
        amount: amountRaw,
        keepLast: opts.keepLast ?? null,
        model,
        busyTimeoutMs,
      });

      process.stdout.write(`[evs] auto-compact started session=${sessionId}\n`);

      const cliPath = process.argv[1];
      if (!cliPath) throw new Error("[AutoCompact] Cannot determine CLI path to spawn background process.");

      const args = [
        cliPath,
        "auto-compact",
        "run",
        "--cwd",
        cwd,
        "--session",
        sessionPath,
        "--threshold",
        String(thresholdTokens),
        ...(amountMode === "tokens" ? ["--amount-tokens", amountRaw] : ["--amount", amountRaw]),
        "--model",
        model,
        "--busy-timeout",
        `${busyTimeoutMs}ms`,
      ];
      if (opts.keepLast) args.push("--keep-last", opts.keepLast);
      if (opts.notify) args.push("--notify");

      spawnDetached(args);
    });

  cmd
    .command("run")
    .description("Run auto-compact synchronously (worker)")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .option("--session <path>", "Claude session JSONL path (overrides --cwd resolution)")
    .option("--threshold <n>", "token threshold (e.g. 140k)", "140k")
    .option("--amount <n|%>", "amount to compact (default: 25%)", "25%")
    .option("--amount-messages <n|%>", "amount to compact by messages (alias for --amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (e.g. 25% or 30k)")
    .option("--keep-last <n>", "keep last N messages (integer)")
    .option("--model <model>", "haiku|sonnet|opus (default: haiku)", "haiku")
    .option("--busy-timeout <duration>", "max time to wait on locks/file stability (default: 10s)", "10s")
    .option("--notify", "send OS notification on successful compact")
    .action(
      async (opts: {
        cwd?: string;
        session?: string;
        threshold: string;
        amount: string;
        amountMessages?: string;
        amountTokens?: string;
        keepLast?: string;
        model: string;
        busyTimeout: string;
        notify?: boolean;
      }) => {
      const hook = await readClaudeHookInputIfAny(25);
      const cwd = resolveClaudeActiveCwd(opts.cwd ?? hook?.cwd);
      const thresholdTokens = parseTokenThreshold(opts.threshold);
      const model = isClaudeAutoCompactModel(opts.model) ? opts.model : "haiku";
      const busyTimeoutMs = parseDurationMs(opts.busyTimeout);

      const amountTokensRaw = opts.amountTokens?.trim();
      const amountMessagesRaw = opts.amountMessages?.trim();
      if (amountTokensRaw && amountMessagesRaw) {
        process.stderr.write("[evs auto-compact] Use either --amount-messages or --amount-tokens (not both).\n");
        process.exitCode = 2;
        return;
      }
      if (amountTokensRaw && opts.keepLast && opts.keepLast.trim().length > 0) {
        process.stderr.write("[evs auto-compact] --amount-tokens cannot be combined with --keep-last.\n");
        process.exitCode = 2;
        return;
      }

      const amountMode: AutoCompactAmountMode = amountTokensRaw ? "tokens" : "messages";
      const amountRaw = amountTokensRaw ?? amountMessagesRaw ?? opts.amount;

      const params: AutoCompactRunOptions = {
        cwd,
        thresholdTokens,
        amountMode,
        amountRaw,
        model,
        busyTimeoutMs,
      };
      const sessionPath = await resolveClaudeSessionPathFromInputs({
        cwd,
        ...(hook?.transcriptPath ? { hookPath: hook.transcriptPath } : {}),
        ...(opts.session ? { explicitPath: opts.session } : {}),
      });
      if (sessionPath) params.sessionPath = sessionPath;
      if (opts.keepLast) params.keepLastRaw = opts.keepLast;
      if (opts.notify) params.notify = true;

      const out = await runClaudeAutoCompactOnce(params);

      process.exitCode = out.result === "success" || out.result === "pending_ready" || out.result === "not_triggered" ? 0 : 1;
    });
}
