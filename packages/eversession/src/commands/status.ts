import type { Command } from "commander";
import { getTokenizer } from "@anthropic-ai/tokenizer";

import { parseCodexSession } from "../agents/codex/session.js";
import type { SessionDiscoveryReport } from "../agents/session-discovery/types.js";
import { getCodexMessageText } from "../agents/codex/text.js";
import { printIssuesHuman } from "../core/cli.js";
import type { Issue } from "../core/issues.js";
import { asNumber, asString, isJsonObject } from "../core/json.js";
import { resolveEvsConfigForCwd } from "../core/project-config.js";
import { lockPathForSession } from "../core/paths.js";
import { parseTokensOrPercent } from "../core/spec.js";
import { parseTokenThreshold } from "../core/threshold.js";
import { resolveClaudeActiveSession, toClaudeSessionDiscoveryReport } from "../integrations/claude/active-session.js";
import { resolveClaudeProjectDirFromEnv } from "../integrations/claude/context.js";
import { readClaudeHookInputIfAny } from "../integrations/claude/hook-input.js";
import { defaultClaudeProjectsDir } from "../integrations/claude/paths.js";
import { countClaudeMessageTokensFromFile } from "../integrations/claude/session-metrics.js";
import { readAutoCompactThresholdFromProjectSettings, readClaudeAutoCompactSignals } from "../integrations/claude/statusline.js";
import { getLogPath } from "../integrations/claude/eversession-session-storage.js";
import { readPendingCompact } from "../integrations/claude/pending-compact.js";
import { fileExists } from "../core/fs.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { readCodexPendingCompact } from "../integrations/codex/pending-compact.js";
import { defaultCodexThresholdFromContextWindow } from "../integrations/codex/auto-compact.js";

type AgentChoice = "auto" | "claude" | "codex";

type StatusMode = "Waiting" | "Reload" | "Compacting" | "Over" | "Active";

type StatusReport = {
  agent: "claude" | "codex";
  cwd: string;
  session: { path: string; id?: string };
  mode: StatusMode;
  tokens?: { current?: number; threshold?: number; bar?: string; currentEstimated?: true };
};

function formatK(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(value);
  const k = value / 1000;
  if (k < 10) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}

function formatProgressBar(current: number | undefined, threshold: number | undefined, width: number): string | undefined {
  if (current === undefined) return undefined;
  if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) return undefined;

  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
  const ratio = Math.max(0, Math.min(1, current / threshold));
  const filled = Math.max(0, Math.min(safeWidth, Math.floor(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  const bar = "█".repeat(filled) + "▒".repeat(empty);
  return `[${bar}]`;
}

function renderStatusLine(report: StatusReport): string {
  const current = report.tokens?.current;
  const threshold = report.tokens?.threshold;
  const bar = report.tokens?.bar;
  const currentEstimated = report.tokens?.currentEstimated === true;

  const tokensText =
    current !== undefined && threshold !== undefined
      ? `${currentEstimated ? "~" : ""}${formatK(current)}/${formatK(threshold)}`
      : current !== undefined
        ? `${currentEstimated ? "~" : ""}${formatK(current)}/?`
        : threshold !== undefined
          ? `?/${formatK(threshold)}`
          : "?/?";

  const barSuffix = bar ? ` ${bar}` : "";
  return `EVS: ${report.mode} ${tokensText}${barSuffix}\n`;
}

function isAgentChoice(value: string): value is AgentChoice {
  return value === "auto" || value === "claude" || value === "codex";
}

async function resolveSessionReportForStatus(opts: {
  agent: AgentChoice;
  cwd: string;
  sessionId?: string;
  match?: string;
  fallback: boolean;
  lookbackDays: number;
  maxCandidates: number;
  tailLines: number;
  claudeProjectsDir: string;
  codexSessionsDir: string;
}): Promise<SessionDiscoveryReport> {
  if (opts.agent === "claude") {
    const hook = await readClaudeHookInputIfAny(25);
    const resolved = await resolveClaudeActiveSession({
      cwd: opts.cwd,
      claudeProjectsDir: opts.claudeProjectsDir,
      ...(hook ? { hook } : {}),
      allowDiscover: true,
      validate: false,
    });
    if ("error" in resolved) {
      const issues: Issue[] = [
        {
          severity: "error",
          code: "claude.session_not_found",
          message: "[Claude] No session found for this project.",
          location: { kind: "file", path: opts.cwd },
        },
      ];
      return { agent: "unknown", cwd: opts.cwd, issues, alternatives: [] };
    }
    return toClaudeSessionDiscoveryReport(resolved);
  }

  if (opts.agent === "codex") {
    return discoverCodexSessionReport({
      cwd: opts.cwd,
      codexSessionsDir: opts.codexSessionsDir,
      fallback: opts.fallback,
      lookbackDays: opts.lookbackDays,
      maxCandidates: opts.maxCandidates,
      tailLines: opts.tailLines,
      validate: false,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.match ? { match: opts.match } : {}),
    });
  }

  // auto: prefer Claude only when we have explicit execution context (hook/env), otherwise try Codex.
  if (!opts.sessionId && !opts.match) {
    const hook = await readClaudeHookInputIfAny(25);
    const resolved = await resolveClaudeActiveSession({
      cwd: opts.cwd,
      claudeProjectsDir: opts.claudeProjectsDir,
      ...(hook ? { hook } : {}),
      allowDiscover: false,
      validate: false,
    });
    if (!("error" in resolved)) return toClaudeSessionDiscoveryReport(resolved);
  }

  const codex = await discoverCodexSessionReport({
    cwd: opts.cwd,
    codexSessionsDir: opts.codexSessionsDir,
    fallback: opts.fallback,
    lookbackDays: opts.lookbackDays,
    maxCandidates: opts.maxCandidates,
    tailLines: opts.tailLines,
    validate: false,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.match ? { match: opts.match } : {}),
  });
  if (codex.agent !== "unknown") return codex;

  const hook = await readClaudeHookInputIfAny(25);
  const resolved = await resolveClaudeActiveSession({
    cwd: opts.cwd,
    claudeProjectsDir: opts.claudeProjectsDir,
    ...(hook ? { hook } : {}),
    allowDiscover: true,
    validate: false,
  });
  if (!("error" in resolved)) return toClaudeSessionDiscoveryReport(resolved);

  return codex;
}

async function buildClaudeStatusReport(params: {
  cwd: string;
  sessionPath: string;
  sessionId?: string;
  thresholdOverride?: number;
  barWidth: number;
}): Promise<StatusReport> {
  const sessionId = params.sessionId;
  const logPath = sessionId ? getLogPath(sessionId) : undefined;
  const lockPath = lockPathForSession(params.sessionPath);

  const [isLock, tokens, pendingCompact, signals] = await Promise.all([
    fileExists(lockPath),
    countClaudeMessageTokensFromFile(params.sessionPath),
    sessionId ? readPendingCompact(sessionId) : Promise.resolve(undefined),
    logPath ? readClaudeAutoCompactSignals(logPath) : Promise.resolve(undefined),
  ]);

  const thresholdFromLog = signals?.lastStart?.threshold ?? signals?.lastResult?.threshold;
  const claudeProjectDir = resolveClaudeProjectDirFromEnv();
  const thresholdFromSettings =
    claudeProjectDir && !params.thresholdOverride ? await readAutoCompactThresholdFromProjectSettings(claudeProjectDir) : undefined;
  const threshold = params.thresholdOverride ?? thresholdFromLog ?? thresholdFromSettings;

  const overThreshold = tokens !== undefined && threshold !== undefined ? tokens >= threshold : false;
  const isCompacting = (isLock && overThreshold) || pendingCompact?.status === "running";

  const successTsMs = signals?.lastSuccess?.ts ? Date.parse(signals.lastSuccess.ts) : Number.NaN;
  const sessionStartTsMs = signals?.lastSessionStart?.ts ? Date.parse(signals.lastSessionStart.ts) : Number.NaN;
  const hasSuccess = Number.isFinite(successTsMs) && successTsMs > 0;
  const hasSessionStart = Number.isFinite(sessionStartTsMs) && sessionStartTsMs > 0;
  const hasPendingReady = pendingCompact?.status === "ready";
  const needsReload = hasPendingReady || (hasSuccess && (!hasSessionStart || successTsMs > sessionStartTsMs));

  const mode: StatusMode = isCompacting ? "Compacting" : needsReload ? "Reload" : "Waiting";

  const bar = formatProgressBar(tokens, threshold, params.barWidth);
  return {
    agent: "claude",
    cwd: params.cwd,
    session: { path: params.sessionPath, ...(sessionId ? { id: sessionId } : {}) },
    mode,
    tokens: {
      ...(tokens !== undefined ? { current: tokens } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(bar ? { bar } : {}),
    },
  };
}

function extractCodexSessionIdFromWrapped(session: Awaited<ReturnType<typeof parseCodexSession>>["session"]): string | undefined {
  if (!session || session.format !== "wrapped") return undefined;
  for (const line of session.lines) {
    if (line.kind !== "wrapped") continue;
    if (line.type !== "session_meta") continue;
    if (!isJsonObject(line.payload)) continue;
    const id = asString(line.payload.id);
    if (id) return id;
  }
  return undefined;
}

function extractLastCodexTokenCount(session: Awaited<ReturnType<typeof parseCodexSession>>["session"]): {
  tokens?: number;
  modelContextWindow?: number;
  timestampMs?: number;
} {
  if (!session || session.format !== "wrapped") return {};

  for (let i = session.lines.length - 1; i >= 0; i -= 1) {
    const line = session.lines[i];
    if (!line || line.kind !== "wrapped") continue;
    if (line.type !== "event_msg") continue;
    if (!isJsonObject(line.payload)) continue;
    if (asString(line.payload.type) !== "token_count") continue;

    const info = line.payload.info;
    if (!isJsonObject(info)) continue;
    const lastUsage = isJsonObject(info.last_token_usage) ? info.last_token_usage : undefined;
    const totalUsage = isJsonObject(info.total_token_usage) ? info.total_token_usage : undefined;
    const tokens =
      (lastUsage ? asNumber(lastUsage.total_tokens) : undefined) ??
      (totalUsage ? asNumber(totalUsage.total_tokens) : undefined);
    const modelContextWindow = asNumber(info.model_context_window);
    if (tokens !== undefined) {
      const timestampMs = Date.parse(line.timestamp);
      return {
        tokens,
        ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
        ...(Number.isFinite(timestampMs) && timestampMs > 0 ? { timestampMs } : {}),
      };
    }
  }

  return {};
}

function maxCodexCompactedTimestampMs(session: Awaited<ReturnType<typeof parseCodexSession>>["session"]): number | undefined {
  if (!session || session.format !== "wrapped") return undefined;
  let max = 0;
  for (const line of session.lines) {
    if (line.kind !== "wrapped") continue;
    if (line.type !== "compacted") continue;
    const ms = Date.parse(line.timestamp);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms > max) max = ms;
  }
  return max > 0 ? max : undefined;
}

type Tokenizer = ReturnType<typeof getTokenizer>;

function countTokensWithTokenizer(tokenizer: Tokenizer, text: string): number {
  if (text.length === 0) return 0;
  return tokenizer.encode(text.normalize("NFKC"), "all").length;
}

function ensureTrailingNewline(text: string): string {
  if (text.length === 0) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

function formatCodexResponseItemForEstimate(payload: Record<string, unknown>): string | undefined {
  const t = asString(payload.type);
  if (!t) return undefined;

  if (t === "message") {
    const role = asString(payload.role);
    if (!role) return undefined;
    const text = getCodexMessageText(payload).trim();
    if (text.length === 0) return undefined;
    return `[${role}]: ${text}`;
  }

  const callTypes = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
  if (callTypes.has(t)) {
    const name = asString(payload.name) ?? t;
    return `[assistant]: [tool: ${name}]\n${JSON.stringify(payload)}`;
  }

  const outputTypes = new Set(["function_call_output", "custom_tool_call_output"]);
  if (outputTypes.has(t)) {
    const callId = asString(payload.call_id);
    const label = callId ? `${t} ${callId}` : t;
    return `[assistant]: [result: ${label}]\n${JSON.stringify(payload)}`;
  }

  return undefined;
}

function estimateCodexTokensFromSession(session: Awaited<ReturnType<typeof parseCodexSession>>["session"]): number | undefined {
  if (!session || session.format !== "wrapped") return undefined;

  let tokenizer: Tokenizer | undefined;
  try {
    tokenizer = getTokenizer();
  } catch {
    return undefined;
  }

  try {
    let total = 0;
    for (const line of session.lines) {
      if (line.kind !== "wrapped") continue;
      if (line.type !== "response_item") continue;
      if (!isJsonObject(line.payload)) continue;
      const formatted = formatCodexResponseItemForEstimate(line.payload);
      if (!formatted) continue;
      total += countTokensWithTokenizer(tokenizer, ensureTrailingNewline(formatted));
    }
    return total;
  } finally {
    try {
      tokenizer.free();
    } catch {
      // ignore
    }
  }
}

function thresholdTokensFromSpec(spec: ReturnType<typeof parseTokensOrPercent>, modelContextWindow: number | undefined): number | undefined {
  if (spec.kind === "tokens") return spec.tokens;
  if (modelContextWindow === undefined) return undefined;
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) return undefined;
  const percent = spec.percent;
  if (!Number.isFinite(percent) || percent < 0) return undefined;
  return Math.floor((modelContextWindow * percent) / 100);
}

async function tryResolveCodexThresholdFromProjectConfig(cwd: string, modelContextWindow: number | undefined): Promise<number | undefined> {
  try {
    const loaded = await resolveEvsConfigForCwd(cwd);
    const cfgAuto = loaded.config.codex?.autoCompact;
    if (cfgAuto?.enabled === false) return undefined;
    const raw = cfgAuto?.threshold?.trim();
    if (!raw) return undefined;
    const spec = parseTokensOrPercent(raw);
    return thresholdTokensFromSpec(spec, modelContextWindow);
  } catch {
    return undefined;
  }
}

async function buildCodexStatusReport(params: {
  cwd: string;
  sessionPath: string;
  sessionId?: string;
  thresholdOverride?: number;
  barWidth: number;
}): Promise<StatusReport> {
  const parsed = await parseCodexSession(params.sessionPath);
  const sessionId = params.sessionId ?? extractCodexSessionIdFromWrapped(parsed.session);
  const tokenCount = extractLastCodexTokenCount(parsed.session);
  const thresholdFromConfig =
    params.thresholdOverride === undefined
      ? await tryResolveCodexThresholdFromProjectConfig(params.cwd, tokenCount.modelContextWindow)
      : undefined;
  const threshold = params.thresholdOverride ?? thresholdFromConfig ?? defaultCodexThresholdFromContextWindow(tokenCount.modelContextWindow);

  const lastCompactedMs = maxCodexCompactedTimestampMs(parsed.session);
  const tokenCountMs = tokenCount.timestampMs;
  const tokensStale = lastCompactedMs !== undefined && tokenCountMs !== undefined && lastCompactedMs > tokenCountMs;
  const estimatedTokens = tokensStale ? estimateCodexTokensFromSession(parsed.session) : undefined;
  const displayTokens = estimatedTokens ?? tokenCount.tokens;

  const lockPath = lockPathForSession(params.sessionPath);
  const [isLock, pending] = await Promise.all([
    fileExists(lockPath),
    sessionId ? readCodexPendingCompact(sessionId) : Promise.resolve(undefined),
  ]);

  const overThreshold = displayTokens !== undefined && threshold !== undefined ? displayTokens >= threshold : false;
  const isCompacting = (isLock && overThreshold) || pending?.status === "running";
  const needsReload = pending?.status === "ready";

  const baseMode: StatusMode = threshold === undefined ? "Active" : overThreshold ? "Over" : "Waiting";
  const mode: StatusMode = isCompacting ? "Compacting" : needsReload ? "Reload" : baseMode;
  const bar = formatProgressBar(displayTokens, threshold, params.barWidth);

  return {
    agent: "codex",
    cwd: params.cwd,
    session: { path: params.sessionPath, ...(sessionId ? { id: sessionId } : {}) },
    mode,
    tokens: {
      ...(displayTokens !== undefined ? { current: displayTokens } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(bar ? { bar } : {}),
      ...(displayTokens !== undefined && estimatedTokens !== undefined ? { currentEstimated: true } : {}),
    },
  };
}

export type StatusCommandOptions = {
  agent: string;
  cwd?: string;
  sessionId?: string;
  match?: string;
  fallback: string;
  lookbackDays: string;
  maxCandidates: string;
  tailLines: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  threshold?: string;
  barWidth: string;
  json?: boolean;
};

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show EVS status for the active session (Claude Code or Codex)")
    .option("--agent <agent>", "auto|claude|codex (default: auto)", "auto")
    .option("--cwd <path>", "target working directory (default: process.cwd())")
    .option("--session-id <id>", "exact session id / conversation id to resolve (Codex: fastest)")
    .option("--match <text>", "search candidate sessions by tail content (expensive)")
    .option("--fallback <on|off>", "Codex: allow global fallback outside this project (default: on)", "on")
    .option("--lookback-days <n>", "Codex: how many days back to scan (default: 14)", "14")
    .option("--max-candidates <n>", "limit number of candidate files to inspect (default: 200)", "200")
    .option("--tail-lines <n>", "how many last JSONL lines to inspect (default: 500)", "500")
    .option("--claude-projects-dir <dir>", "override ~/.claude/projects (advanced)")
    .option("--codex-sessions-dir <dir>", "override ~/.codex/sessions (advanced)")
    .option("--threshold <n>", "override threshold (e.g. 100k)")
    .option("--bar-width <n>", "progress bar width (default: 8)", "8")
    .option("--json", "output JSON")
    .action(async (opts: StatusCommandOptions) => {
      const cwd = opts.cwd ?? process.cwd();
      const agentRaw = (opts.agent ?? "auto").trim();
      if (!isAgentChoice(agentRaw)) {
        printIssuesHuman([
          {
            severity: "error",
            code: "core.invalid_agent",
            message: `[Core] Invalid --agent value: ${opts.agent} (expected auto|claude|codex).`,
            location: { kind: "file", path: cwd },
          },
        ]);
        process.exitCode = 2;
        return;
      }

      let thresholdOverride: number | undefined;
      if (opts.threshold) {
        try {
          thresholdOverride = parseTokenThreshold(opts.threshold);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          printIssuesHuman([
            {
              severity: "error",
              code: "core.invalid_threshold",
              message,
              location: { kind: "file", path: cwd },
            },
          ]);
          process.exitCode = 2;
          return;
        }
      }

      const barWidthRaw = Number(opts.barWidth);
      const barWidth = Number.isFinite(barWidthRaw) && barWidthRaw > 0 ? Math.floor(barWidthRaw) : 8;

      const fallback = opts.fallback !== "off";
      const lookbackDaysRaw = Number(opts.lookbackDays);
      const maxCandidatesRaw = Number(opts.maxCandidates);
      const tailLinesRaw = Number(opts.tailLines);

      const report = await resolveSessionReportForStatus({
        agent: agentRaw,
        cwd,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.match ? { match: opts.match } : {}),
        fallback,
        lookbackDays: Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ? Math.floor(lookbackDaysRaw) : 14,
        maxCandidates: Number.isFinite(maxCandidatesRaw) && maxCandidatesRaw > 0 ? Math.floor(maxCandidatesRaw) : 200,
        tailLines: Number.isFinite(tailLinesRaw) && tailLinesRaw > 0 ? Math.floor(tailLinesRaw) : 500,
        claudeProjectsDir: opts.claudeProjectsDir ?? defaultClaudeProjectsDir(),
        codexSessionsDir: opts.codexSessionsDir ?? defaultCodexSessionsDir(),
      });

      if (report.agent === "unknown") {
        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else printIssuesHuman(report.issues);
        process.exitCode = 2;
        return;
      }

      if (report.confidence !== "high") {
        process.stderr.write("[evs status] Cannot determine current session with high confidence (ambiguous).\n");
        process.stderr.write("Pass an explicit id:\n  evs status --session-id <uuid>\n");
        process.exitCode = 2;
        return;
      }

      const sessionPath = report.session.path;
      const sessionId = report.session.id;

      let statusReport: StatusReport;
      if (report.agent === "claude") {
        statusReport = await buildClaudeStatusReport({
          cwd: report.cwd,
          sessionPath,
          ...(sessionId ? { sessionId } : {}),
          ...(thresholdOverride !== undefined ? { thresholdOverride } : {}),
          barWidth,
        });
      } else {
        statusReport = await buildCodexStatusReport({
          cwd: report.cwd,
          sessionPath,
          ...(sessionId ? { sessionId } : {}),
          ...(thresholdOverride !== undefined ? { thresholdOverride } : {}),
          barWidth,
        });
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(statusReport, null, 2) + "\n");
        process.exitCode = 0;
        return;
      }

      process.stdout.write(renderStatusLine(statusReport));
      process.exitCode = 0;
    });
}

