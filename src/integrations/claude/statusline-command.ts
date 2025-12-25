import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileExists } from "../../core/fs.js";
import { asString, isJsonObject } from "../../core/json.js";
import { deriveSessionIdFromPath, lockPathForSession } from "../../core/paths.js";
import { getClaudeStatuslineEnvDump, resolveClaudeProjectDirFromEnv } from "./context.js";
import { getLogPath } from "./eversession-session-storage.js";
import { readPendingCompact } from "./pending-compact.js";
import { countClaudeMessageTokensFromFile } from "./session-metrics.js";
import { loadClaudeSettings, resolveClaudeSettingsPath, saveClaudeSettings } from "./settings.js";
import {
  defaultStatuslineDumpPath,
  extractClaudeStatuslineFields,
  isEvsStatuslineCommand,
  readAutoCompactConfigFromProjectSettings,
  readAutoCompactThresholdFromProjectSettings,
  readClaudeAutoCompactSignals,
} from "./statusline.js";
import { readClaudeSupervisorEnv } from "./supervisor-control.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_BLUE = "\u001b[34m";
const ANSI_BRIGHT_MAGENTA = "\u001b[95m";
const ANSI_BRIGHT_BLACK = "\u001b[90m";
const ANSI_RED = "\u001b[31m";
const ANSI_GREEN = "\u001b[32m";

type StatuslineDumpRecord = {
  ts: string;
  cwd: string;
  dumpPath: string;
  rawTextBytes?: number;
  parseError?: string;
  payload?: unknown;
  extracted?: {
    transcriptPath?: string;
    sessionId?: string;
    claudeProjectDir?: string;
  };
  env?: {
    CLAUDE_PROJECT_DIR?: string;
    CLAUDE_ENV_FILE?: string;
    PWD?: string;
  };
};

async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

function spawnDetached(argv: string[]): void {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
  child.unref();
}

function formatK(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(value);
  const k = value / 1000;
  if (k < 10) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}

function formatProgressBar(
  current: number | undefined,
  threshold: number | undefined,
  width: number = 8,
): string | undefined {
  if (current === undefined) return undefined;
  if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) return undefined;

  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
  const ratio = Math.max(0, Math.min(1, current / threshold));
  const filled = Math.max(0, Math.min(safeWidth, Math.floor(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);

  const bar = "█".repeat(filled) + "▒".repeat(empty);
  return `${bar}`;
}

function withAnsi(text: string, ansiCode?: string): string {
  if (!ansiCode) return text;
  return `${ansiCode}${text}${ANSI_RESET}`;
}

async function readStdinTextIfAny(timeoutMs: number, maxBytes: number): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;

  const text = await new Promise<string | undefined>((resolve) => {
    let finished = false;
    let gotData = false;
    const chunks: string[] = [];
    let totalBytes = 0;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: string | undefined): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      resolve(value);
    };

    const onData = (chunk: string): void => {
      gotData = true;
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > maxBytes) {
        chunks.push(chunk);
        process.stdin.pause();
        finish(chunks.join("").slice(0, maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(chunks.join(""));
    const onError = (): void => finish(undefined);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);

    timer = setTimeout(() => {
      if (!gotData) {
        process.stdin.pause();
        finish(undefined);
      }
    }, timeoutMs);
  });

  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

type StatuslineOptions = {
  dump?: string | true;
  dumpEnv?: boolean;
  timeoutMs: string;
  maxBytes: string;
};

export async function runClaudeStatuslineCommand(opts: StatuslineOptions): Promise<void> {
  const timeoutMs = Number(opts.timeoutMs);
  const maxBytes = Number(opts.maxBytes);

  const inputText = await readStdinTextIfAny(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 50,
    Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 262_144,
  );

  let payload: unknown;
  let parseError: string | undefined;
  if (inputText) {
    try {
      payload = JSON.parse(inputText) as unknown;
    } catch (err) {
      payload = undefined;
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const extracted = payload ? extractClaudeStatuslineFields(payload) : undefined;
  const transcriptPath = extracted?.transcriptPath;
  const extractedSessionId = extracted?.sessionId;
  const claudeProjectDir = resolveClaudeProjectDirFromEnv();

  const wantsDump = opts.dump !== undefined || process.env.EVS_STATUSLINE_DUMP_PATH !== undefined;
  if (wantsDump) {
    const dumpPath =
      process.env.EVS_STATUSLINE_DUMP_PATH ??
      (opts.dump === true || opts.dump === undefined ? defaultStatuslineDumpPath() : String(opts.dump));

    const record: StatuslineDumpRecord = {
      ts: new Date().toISOString(),
      cwd: process.cwd(),
      dumpPath,
      ...(inputText ? { rawTextBytes: Buffer.byteLength(inputText, "utf8") } : {}),
      ...(parseError ? { parseError } : {}),
      ...(payload ? { payload } : {}),
      extracted: {
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(extractedSessionId ? { sessionId: extractedSessionId } : {}),
        ...(claudeProjectDir ? { claudeProjectDir } : {}),
      },
      ...(opts.dumpEnv ? { env: getClaudeStatuslineEnvDump() } : {}),
    };

    try {
      await appendJsonl(dumpPath, record);
    } catch {
      // Never break Claude UI because of dump logging.
    }
  }

  // Statusline contract: print a single line.
  if (!transcriptPath) {
    process.stdout.write("EVS: active\n");
    return;
  }

  const sessionId = deriveSessionIdFromPath(transcriptPath);
  const logPath = getLogPath(sessionId);
  const lockPath = lockPathForSession(transcriptPath);

  const [isLock, signals, tokens, pendingCompact] = await Promise.all([
    fileExists(lockPath),
    readClaudeAutoCompactSignals(logPath),
    countClaudeMessageTokensFromFile(transcriptPath),
    readPendingCompact(sessionId),
  ]);

  const thresholdFromLog = signals.lastStart?.threshold ?? signals.lastResult?.threshold;
  const threshold =
    thresholdFromLog ??
    (claudeProjectDir ? await readAutoCompactThresholdFromProjectSettings(claudeProjectDir) : undefined);

  // "COMPACTING" should mean "actual compaction expected / in progress", not merely "auto-compact check is running".
  const overThreshold = tokens !== undefined && threshold !== undefined ? tokens >= threshold : false;
  const isCompacting = (isLock && overThreshold) || pendingCompact?.status === "running";
  const successTsMs = signals.lastSuccess?.ts ? Date.parse(signals.lastSuccess.ts) : NaN;
  const sessionStartTsMs = signals.lastSessionStart?.ts ? Date.parse(signals.lastSessionStart.ts) : NaN;
  const hasSuccess = Number.isFinite(successTsMs) && successTsMs > 0;
  const hasSessionStart = Number.isFinite(sessionStartTsMs) && sessionStartTsMs > 0;
  const hasPendingReady = pendingCompact?.status === "ready";
  const needsReload = hasPendingReady || (hasSuccess && (!hasSessionStart || successTsMs > sessionStartTsMs));

  // Preemptive auto-compact: when over threshold, start a background precompute early,
  // but only if we can apply safely at the reload boundary (supervised mode).
  const supervisor = readClaudeSupervisorEnv();
  const lastResultTsMs = signals.lastResult?.ts ? Date.parse(signals.lastResult.ts) : NaN;
  const recentlyAttempted =
    Number.isFinite(lastResultTsMs) && lastResultTsMs > 0 ? Date.now() - lastResultTsMs < 30_000 : false;
  const shouldTriggerPrecompute =
    supervisor !== undefined &&
    overThreshold &&
    threshold !== undefined &&
    !needsReload &&
    !isLock &&
    !hasPendingReady &&
    !recentlyAttempted;
  if (shouldTriggerPrecompute) {
    try {
      const config = claudeProjectDir ? await readAutoCompactConfigFromProjectSettings(claudeProjectDir) : undefined;
      const amountTokens = config?.amountTokens;
      const amountMessages = config?.amountMessages;
      const amount = config?.amount;
      const keepLast = config?.keepLast;
      const maxTokens = config?.maxTokens;
      const model = config?.model ?? "haiku";
      const busyTimeout = config?.busyTimeout ?? "10s";
      const defaultAmountTokens = "40%";
      const defaultAmountMessages = "25%";

      const cliPath = process.argv[1];
      if (cliPath) {
        const args = [
          cliPath,
          "auto-compact",
          "run",
          "--session",
          transcriptPath,
          "--threshold",
          String(threshold),
          "--model",
          model,
          "--busy-timeout",
          busyTimeout,
        ];
        if (maxTokens !== undefined && maxTokens.trim().length > 0) args.push("--max-tokens", maxTokens);
        const keepLastRaw = keepLast;
        const hasAmountTokens = amountTokens !== undefined && amountTokens.trim().length > 0;

        if (keepLastRaw !== undefined && keepLastRaw.trim().length > 0 && !hasAmountTokens) {
          args.push("--amount-messages", amountMessages ?? amount ?? defaultAmountMessages);
          args.push("--keep-last", keepLastRaw);
        } else if (amountTokens) {
          args.push("--amount-tokens", amountTokens);
        } else if (amountMessages) {
          args.push("--amount-messages", amountMessages);
        } else if (amount) {
          args.push("--amount-messages", amount);
        } else {
          args.push("--amount-tokens", defaultAmountTokens);
        }

        spawnDetached(args);
      }
    } catch {
      // Never break Claude UI because of background triggers.
    }
  }

  const mode = isCompacting
    ? withAnsi("Compacting", ANSI_GREEN)
    : needsReload
      ? withAnsi("Reload", ANSI_BLUE)
      : withAnsi("Waiting", ANSI_YELLOW);

  const autoPrefix = process.env.EVS_CLAUDE_RELOAD_MODE === "auto" ? `${withAnsi("auto", ANSI_BRIGHT_MAGENTA)} ` : "";

  const thresholdText = threshold !== undefined ? formatK(threshold) : "?";
  // When a reload is needed, Claude may keep appending entries using stale parentUuids (until restart),
  // which can break the chain-based `/context → Messages` count and make it look like tokens dropped to ~0.
  // Prefer the last successful compact's tokensAfter (from EVS log) to keep UX stable.
  const displayTokens =
    needsReload && !hasPendingReady && signals.lastSuccess?.tokensAfter !== undefined
      ? signals.lastSuccess.tokensAfter
      : tokens;
  const currentTokensText = displayTokens !== undefined ? formatK(displayTokens) : "?";
  const currentAnsi =
    displayTokens !== undefined && threshold !== undefined && displayTokens >= threshold ? ANSI_RED : undefined;
  const tokensText = `${withAnsi(currentTokensText, currentAnsi)}${withAnsi("/", ANSI_BRIGHT_BLACK)}${withAnsi(thresholdText, ANSI_BRIGHT_BLACK)}`;
  const barText = formatProgressBar(displayTokens, threshold, 8);
  const barSuffix = barText ? ` ${barText}` : "";
  process.stdout.write(`EVS: ${autoPrefix}${mode} ${tokensText}${barSuffix}\n`);
}

type StatuslineInstallOptions = {
  global?: boolean;
  force?: boolean;
};

export async function runClaudeStatuslineInstall(cmdOpts: StatuslineInstallOptions): Promise<void> {
  try {
    const settingsPath = resolveClaudeSettingsPath({ global: cmdOpts.global === true, cwd: process.cwd() });
    const settings = await loadClaudeSettings(settingsPath);

    const existing = settings.statusLine;
    if (isJsonObject(existing)) {
      const existingCommand = asString(existing.command);
      if (existingCommand && isEvsStatuslineCommand(existingCommand)) {
        console.log("○ Status line already configured for EverSession.");
        return;
      }

      if (!cmdOpts.force) {
        console.log("○ Skipped: statusLine already configured (use --force to overwrite).");
        return;
      }
    } else if (existing !== undefined && !cmdOpts.force) {
      console.log("○ Skipped: statusLine already configured (use --force to overwrite).");
      return;
    }

    settings.statusLine = {
      type: "command",
      command: "evs statusline",
      padding: 0,
    };

    await saveClaudeSettings(settingsPath, settings);
    console.log("✓ Installed EverSession status line.");
    console.log("Restart Claude Code for changes to take effect.");
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}

type StatuslineUninstallOptions = {
  global?: boolean;
};

export async function runClaudeStatuslineUninstall(cmdOpts: StatuslineUninstallOptions): Promise<void> {
  try {
    const settingsPath = resolveClaudeSettingsPath({ global: cmdOpts.global === true, cwd: process.cwd() });
    const settings = await loadClaudeSettings(settingsPath);

    const existing = settings.statusLine;
    const existingCommand = isJsonObject(existing) ? asString(existing.command) : asString(existing);
    if (!existingCommand || !isEvsStatuslineCommand(existingCommand)) {
      console.log("○ No EverSession status line to uninstall.");
      return;
    }

    delete settings.statusLine;
    await saveClaudeSettings(settingsPath, settings);
    console.log("✓ Uninstalled EverSession status line.");
    console.log("Restart Claude Code for changes to take effect.");
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}
