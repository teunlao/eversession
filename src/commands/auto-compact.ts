import { spawn } from "node:child_process";
import type { Command } from "commander";
import { parseDurationMs } from "../core/duration.js";
import { deriveSessionIdFromPath } from "../core/paths.js";
import { resolveEvsConfigForCwd } from "../core/project-config.js";
import { parseTokenThreshold } from "../core/threshold.js";
import { resolveClaudeSessionPathFromInputs } from "../integrations/claude/active-session.js";
import {
  type AutoCompactAmountMode,
  type AutoCompactRunOptions,
  isClaudeAutoCompactModel,
  runClaudeAutoCompactOnce,
} from "../integrations/claude/auto-compact.js";
import { resolveClaudeActiveCwd } from "../integrations/claude/context.js";
import {
  appendSessionLog,
  readSessionState,
  updateSessionState,
} from "../integrations/claude/eversession-session-storage.js";
import { readClaudeHookInputIfAny } from "../integrations/claude/hook-input.js";
import {
  appendSupervisorControlCommand,
  readClaudeSupervisorEnv,
  readSupervisorHandshake,
} from "../integrations/claude/supervisor-control.js";

function spawnDetached(argv: string[]): void {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
  child.unref();
}

async function resolveClaudeSessionPathForAutoCompact(params: {
  cwd: string;
  hookPath?: string;
  explicitPath?: string;
}): Promise<string | undefined> {
  if (params.explicitPath) return params.explicitPath;
  if (params.hookPath) return params.hookPath;

  const supervisor = readClaudeSupervisorEnv();
  if (!supervisor) return undefined;

  try {
    const hs = await readSupervisorHandshake(supervisor.controlDir);
    if (hs && hs.runId === supervisor.runId && hs.transcriptPath.trim().length > 0) return hs.transcriptPath;
  } catch {
    // ignore handshake errors
  }

  // Best-effort: hooks may still provide context even when not passed explicitly.
  return resolveClaudeSessionPathFromInputs({ cwd: params.cwd, allowDiscover: false });
}

export function registerAutoCompactCommand(program: Command): void {
  const cmd = program
    .command("auto-compact", { hidden: true })
    .description("Internal: auto-compaction orchestrator for Claude Code hooks");

  cmd
    .command("start")
    .description("Start auto-compact in the background (intended for Claude hooks)")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .option("--session <path>", "Claude session JSONL path (overrides --cwd resolution)")
    .option("--threshold <n>", "token threshold (e.g. 140k)")
    .option("--amount <n|%>", "amount to compact by messages (default: 25%)")
    .option("--amount-messages <n|%>", "amount to compact by messages (alias for --amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (default: 40%; e.g. 40% or 30k)")
    .option("--keep-last <n>", "keep last N messages (integer)")
    .option("--max-tokens <n|k>", "max prompt tokens sent to the summarizer model (e.g. 32k)")
    .option("--model <model>", "haiku|sonnet|opus (default: haiku)")
    .option("--busy-timeout <duration>", "max time to wait on locks/file stability (default: 10s)")
    .option("--notify", "send OS notification on successful compact")
    .action(
      async (opts: {
        cwd?: string;
        session?: string;
        threshold?: string;
        amount?: string;
        amountMessages?: string;
        amountTokens?: string;
        keepLast?: string;
        maxTokens?: string;
        model?: string;
        busyTimeout?: string;
        notify?: boolean;
      }) => {
        const hook = await readClaudeHookInputIfAny(25);
        const cwd = resolveClaudeActiveCwd(opts.cwd ?? hook?.cwd);
        const supervisor = readClaudeSupervisorEnv();
        if (!supervisor) {
          // Safety: never auto-compact without an active EVS supervisor.
          process.exitCode = 0;
          return;
        }

        const cfg = await resolveEvsConfigForCwd(cwd);
        const auto = cfg.config.claude?.autoCompact;
        if (auto?.enabled === false) {
          process.exitCode = 0;
          return;
        }

        const thresholdTokens =
          opts.threshold !== undefined
            ? parseTokenThreshold(opts.threshold)
            : auto?.threshold
              ? parseTokenThreshold(auto.threshold)
              : parseTokenThreshold("140k");

        const maxPromptTokens = opts.maxTokens
          ? parseTokenThreshold(opts.maxTokens)
          : auto?.maxTokens
            ? parseTokenThreshold(auto.maxTokens)
            : undefined;

        const modelRaw = opts.model?.trim() ?? auto?.model?.trim();
        const model = isClaudeAutoCompactModel(modelRaw) ? modelRaw : "haiku";

        const busyTimeoutMs = parseDurationMs(opts.busyTimeout?.trim() ?? auto?.busyTimeout ?? "10s");
        const notify = opts.notify ?? auto?.notify ?? false;
        const backup = auto?.backup ?? cfg.config.backup ?? false;

        const defaultAmountTokens = "40%";
        const defaultAmountMessages = "25%";

        const cliAmountTokensRaw = opts.amountTokens?.trim();
        const cliAmountMessagesRaw = opts.amountMessages?.trim();
        const cliAmountArgRaw = opts.amount?.trim();
        const cliKeepLastRaw = opts.keepLast?.trim();

        const cliSpecifiedAmount =
          (cliAmountTokensRaw !== undefined && cliAmountTokensRaw.length > 0) ||
          (cliAmountMessagesRaw !== undefined && cliAmountMessagesRaw.length > 0) ||
          (cliAmountArgRaw !== undefined && cliAmountArgRaw.length > 0) ||
          (cliKeepLastRaw !== undefined && cliKeepLastRaw.length > 0);

        const amountTokensRaw = cliSpecifiedAmount ? cliAmountTokensRaw : auto?.amountTokens?.trim();
        const amountMessagesRaw = cliSpecifiedAmount ? cliAmountMessagesRaw : auto?.amountMessages?.trim();
        const amountArgRaw = cliSpecifiedAmount ? cliAmountArgRaw : undefined;
        const keepLastRaw = cliSpecifiedAmount ? cliKeepLastRaw : auto?.keepLast?.trim();
        if (cliAmountTokensRaw && cliAmountMessagesRaw) {
          process.stderr.write("[evs auto-compact] Use either --amount-messages or --amount-tokens (not both).\n");
          process.exitCode = 2;
          return;
        }
        if (cliAmountTokensRaw && cliAmountArgRaw) {
          process.stderr.write("[evs auto-compact] Use either --amount (messages) or --amount-tokens (not both).\n");
          process.exitCode = 2;
          return;
        }
        if (amountTokensRaw && keepLastRaw && keepLastRaw.trim().length > 0) {
          process.stderr.write("[evs auto-compact] --amount-tokens cannot be combined with --keep-last.\n");
          process.exitCode = 2;
          return;
        }

        const hasKeepLast = keepLastRaw !== undefined && keepLastRaw.trim().length > 0;
        const amountMode: AutoCompactAmountMode =
          amountTokensRaw || (!amountMessagesRaw && !amountArgRaw && !hasKeepLast) ? "tokens" : "messages";
        const amountRaw =
          amountTokensRaw ?? (amountMode === "tokens" ? defaultAmountTokens : amountMessagesRaw ?? amountArgRaw ?? defaultAmountMessages);

        const sessionPath = await resolveClaudeSessionPathForAutoCompact({
          cwd,
          ...(hook?.transcriptPath ? { hookPath: hook.transcriptPath } : {}),
          ...(opts.session ? { explicitPath: opts.session } : {}),
        });
        if (!sessionPath) {
          // No session to work with
          process.exitCode = 0;
          return;
        }

        const sessionId = deriveSessionIdFromPath(sessionPath);

        // Check for pending reload from session state (set by previous compact)
        if (supervisor.reloadMode === "auto") {
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
          keepLast: keepLastRaw ?? null,
          model,
          busyTimeoutMs,
          ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
        });

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
        if (keepLastRaw) args.push("--keep-last", keepLastRaw);
        if (maxPromptTokens !== undefined) args.push("--max-tokens", String(maxPromptTokens));
        if (notify) args.push("--notify");

        spawnDetached(args);
      },
    );

  cmd
    .command("run")
    .description("Run auto-compact synchronously (worker)")
    .option("--cwd <path>", "working directory to resolve session (default: process.cwd())")
    .option("--session <path>", "Claude session JSONL path (overrides --cwd resolution)")
    .option("--threshold <n>", "token threshold (e.g. 140k)")
    .option("--amount <n|%>", "amount to compact by messages (default: 25%)")
    .option("--amount-messages <n|%>", "amount to compact by messages (alias for --amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (default: 40%; e.g. 40% or 30k)")
    .option("--keep-last <n>", "keep last N messages (integer)")
    .option("--max-tokens <n|k>", "max prompt tokens sent to the summarizer model (e.g. 32k)")
    .option("--model <model>", "haiku|sonnet|opus (default: haiku)")
    .option("--busy-timeout <duration>", "max time to wait on locks/file stability (default: 10s)")
    .option("--notify", "send OS notification on successful compact")
    .action(
      async (opts: {
        cwd?: string;
        session?: string;
        threshold?: string;
        amount?: string;
        amountMessages?: string;
        amountTokens?: string;
        keepLast?: string;
        maxTokens?: string;
        model?: string;
        busyTimeout?: string;
        notify?: boolean;
      }) => {
        const hook = await readClaudeHookInputIfAny(25);
        const cwd = resolveClaudeActiveCwd(opts.cwd ?? hook?.cwd);
        const supervisor = readClaudeSupervisorEnv();
        if (!supervisor) {
          process.exitCode = 0;
          return;
        }

        const cfg = await resolveEvsConfigForCwd(cwd);
        const auto = cfg.config.claude?.autoCompact;
        if (auto?.enabled === false) {
          process.exitCode = 0;
          return;
        }

        const thresholdTokens =
          opts.threshold !== undefined
            ? parseTokenThreshold(opts.threshold)
            : auto?.threshold
              ? parseTokenThreshold(auto.threshold)
              : parseTokenThreshold("140k");

        const maxPromptTokens = opts.maxTokens
          ? parseTokenThreshold(opts.maxTokens)
          : auto?.maxTokens
            ? parseTokenThreshold(auto.maxTokens)
            : undefined;

        const modelRaw = opts.model?.trim() ?? auto?.model?.trim();
        const model = isClaudeAutoCompactModel(modelRaw) ? modelRaw : "haiku";

        const busyTimeoutMs = parseDurationMs(opts.busyTimeout?.trim() ?? auto?.busyTimeout ?? "10s");
        const notify = opts.notify ?? auto?.notify ?? false;
        const backup = auto?.backup ?? cfg.config.backup ?? false;

        const defaultAmountTokens = "40%";
        const defaultAmountMessages = "25%";

        const cliAmountTokensRaw = opts.amountTokens?.trim();
        const cliAmountMessagesRaw = opts.amountMessages?.trim();
        const cliAmountArgRaw = opts.amount?.trim();
        const cliKeepLastRaw = opts.keepLast?.trim();

        const cliSpecifiedAmount =
          (cliAmountTokensRaw !== undefined && cliAmountTokensRaw.length > 0) ||
          (cliAmountMessagesRaw !== undefined && cliAmountMessagesRaw.length > 0) ||
          (cliAmountArgRaw !== undefined && cliAmountArgRaw.length > 0) ||
          (cliKeepLastRaw !== undefined && cliKeepLastRaw.length > 0);

        const amountTokensRaw = cliSpecifiedAmount ? cliAmountTokensRaw : auto?.amountTokens?.trim();
        const amountMessagesRaw = cliSpecifiedAmount ? cliAmountMessagesRaw : auto?.amountMessages?.trim();
        const amountArgRaw = cliSpecifiedAmount ? cliAmountArgRaw : undefined;
        const keepLastRaw = cliSpecifiedAmount ? cliKeepLastRaw : auto?.keepLast?.trim();
        if (cliAmountTokensRaw && cliAmountMessagesRaw) {
          process.stderr.write("[evs auto-compact] Use either --amount-messages or --amount-tokens (not both).\n");
          process.exitCode = 2;
          return;
        }
        if (cliAmountTokensRaw && cliAmountArgRaw) {
          process.stderr.write("[evs auto-compact] Use either --amount (messages) or --amount-tokens (not both).\n");
          process.exitCode = 2;
          return;
        }
        if (amountTokensRaw && keepLastRaw && keepLastRaw.trim().length > 0) {
          process.stderr.write("[evs auto-compact] --amount-tokens cannot be combined with --keep-last.\n");
          process.exitCode = 2;
          return;
        }

        const hasKeepLast = keepLastRaw !== undefined && keepLastRaw.trim().length > 0;
        const amountMode: AutoCompactAmountMode =
          amountTokensRaw || (!amountMessagesRaw && !amountArgRaw && !hasKeepLast) ? "tokens" : "messages";
        const amountRaw =
          amountTokensRaw ?? (amountMode === "tokens" ? defaultAmountTokens : amountMessagesRaw ?? amountArgRaw ?? defaultAmountMessages);

        const params: AutoCompactRunOptions = {
          cwd,
          thresholdTokens,
          amountMode,
          amountRaw,
          model,
          busyTimeoutMs,
          backup,
          ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
        };
        const sessionPath = await resolveClaudeSessionPathForAutoCompact({
          cwd,
          ...(hook?.transcriptPath ? { hookPath: hook.transcriptPath } : {}),
          ...(opts.session ? { explicitPath: opts.session } : {}),
        });
        if (sessionPath) params.sessionPath = sessionPath;
        if (keepLastRaw) params.keepLastRaw = keepLastRaw;
        if (notify) params.notify = true;

        const out = await runClaudeAutoCompactOnce(params);

        process.exitCode =
          out.result === "success" || out.result === "pending_ready" || out.result === "not_triggered" ? 0 : 1;
      },
    );
}
