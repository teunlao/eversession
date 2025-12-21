import * as fs from "node:fs/promises";

import { codexAdapter } from "../../agents/codex/adapter.js";
import { compactCodexSession, getCodexCompactionParts } from "../../agents/codex/compact.js";
import type { CodexSession, CodexWrappedLine } from "../../agents/codex/session.js";
import { getCodexMessageText } from "../../agents/codex/text.js";
import { planCodexRemovalByTokens } from "../../agents/codex/tokens.js";
import { type ModelType, buildCompactPrompt } from "../../agents/claude/summary.js";
import { writeFileAtomic } from "../../core/fs.js";
import { countBySeverity, type Issue } from "../../core/issues.js";
import { asNumber, asString, isJsonObject } from "../../core/json.js";
import { stringifyJsonl } from "../../core/jsonl.js";
import { acquireLockWithWait } from "../../core/lock.js";
import { lockPathForSession } from "../../core/paths.js";
import { parseCountOrPercent, parseTokensOrPercent } from "../../core/spec.js";
import { waitForStableFile } from "../../core/file-stability.js";
import { cleanupOldBackups, createSessionBackup } from "../claude/eversession-session-storage.js";
import { appendSupervisorControlCommand, readCodexSupervisorEnv } from "./supervisor-control.js";
import { type CodexPendingCompactSelection, clearCodexPendingCompact, readCodexPendingCompact, writeCodexPendingCompact } from "./pending-compact.js";

export type CodexAutoCompactResult =
  | "not_triggered"
  | "pending_ready"
  | "success"
  | "failed"
  | "busy_timeout"
  | "lock_timeout"
  | "aborted_validation"
  | "no_session"
  | "selection_mismatch";

export type CodexAutoCompactAmountMode = "messages" | "tokens";

export type CodexAutoCompactRunOptions = {
  cwd: string;
  codexSessionsDir: string;
  sessionId: string;
  sessionPath?: string;
  thresholdTokens?: number;
  amountMode: CodexAutoCompactAmountMode;
  amountRaw: string;
  model: ModelType;
  busyTimeoutMs: number;
};

export type CodexAutoCompactRunResult = {
  result: CodexAutoCompactResult;
  usedModel: ModelType;
  sessionPath?: string;
  tokens?: number;
  threshold?: number;
  issues?: Issue[];
  error?: string;
};

function extractLastCodexTokenCount(session: CodexSession | undefined): { tokens?: number; modelContextWindow?: number } {
  if (!session || session.format !== "wrapped") return {};

  for (let i = session.lines.length - 1; i >= 0; i -= 1) {
    const line = session.lines[i];
    if (!line || line.kind !== "wrapped") continue;
    if (line.type !== "event_msg") continue;
    if (!isJsonObject(line.payload)) continue;
    if (asString(line.payload.type) !== "token_count") continue;

    const info = line.payload.info;
    if (!isJsonObject(info)) continue;
    const totalUsage = isJsonObject(info.total_token_usage) ? info.total_token_usage : undefined;
    const tokens = totalUsage ? asNumber(totalUsage.total_tokens) : undefined;
    const modelContextWindow = asNumber(info.model_context_window);

    const out: { tokens?: number; modelContextWindow?: number } = {};
    if (tokens !== undefined) out.tokens = tokens;
    if (modelContextWindow !== undefined) out.modelContextWindow = modelContextWindow;
    return out;
  }

  return {};
}

function defaultThresholdFromContextWindow(modelContextWindow: number | undefined): number | undefined {
  if (modelContextWindow === undefined) return undefined;
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) return undefined;
  // EVS default: trigger earlier than Codex to keep sessions comfortably under the limit.
  return Math.floor((modelContextWindow * 7) / 10);
}

function formatCodexResponseItemForPrompt(payload: Record<string, unknown>): string | undefined {
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

async function generateSummaryFromPrompt(prompt: string, model: ModelType): Promise<string> {
  let summary = "";
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    for await (const message of query({
      prompt,
      options: { model, allowedTools: [], permissionMode: "bypassPermissions" },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block && typeof block.text === "string") summary += block.text;
        }
      }
    }
  } catch (error) {
    throw new Error(`LLM call failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
  if (!summary.trim()) throw new Error("Empty summary generated");
  return summary.trim();
}

function selectionFromPlan(session: CodexSession, removeCountHint: number, deletedLines: Set<number>): CodexPendingCompactSelection {
  const wrapped = session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
  const responseItems = wrapped.filter((l) => l.type === "response_item" && isJsonObject(l.payload));
  const firstKept = responseItems.find((l) => !deletedLines.has(l.line));

  const selection: CodexPendingCompactSelection = { removeCount: removeCountHint };
  if (firstKept) selection.anchorLine = firstKept.line;
  return selection;
}

function selectionMatches(pending: CodexPendingCompactSelection, current: CodexPendingCompactSelection | undefined): boolean {
  if (!current) return false;
  if (pending.removeCount !== current.removeCount) return false;
  if (pending.firstRemovedLine !== undefined && pending.firstRemovedLine !== current.firstRemovedLine) return false;
  if (pending.lastRemovedLine !== undefined && pending.lastRemovedLine !== current.lastRemovedLine) return false;
  if (pending.anchorLine !== undefined && pending.anchorLine !== current.anchorLine) return false;
  return true;
}

function computeSelectionFromChanges(params: {
  session: CodexSession;
  changes: { changes: Array<{ kind: string; line?: number; reason?: string }> };
}): { selection?: CodexPendingCompactSelection; toSummarize: Set<number> } {
  const deleted = new Set<number>();
  const coreRemoved: number[] = [];
  const toSummarize = new Set<number>();

  for (const change of params.changes.changes) {
    if (change.kind !== "delete_line") continue;
    const line = typeof change.line === "number" ? change.line : undefined;
    if (!line || !Number.isFinite(line) || line <= 0) continue;
    deleted.add(line);

    const reason = typeof change.reason === "string" ? change.reason : "";
    if (reason === "Compacted into summary.") coreRemoved.push(line);
    if (
      reason !== "Moved into compaction replacement_history." &&
      reason !== "Dropped prior compacted checkpoint (superseded)." &&
      reason !== "Dropped invalid JSON line (cannot be preserved in JSONL rewrite)."
    ) {
      toSummarize.add(line);
    }
  }

  if (coreRemoved.length === 0) return { toSummarize };
  coreRemoved.sort((a, b) => a - b);

  const selection = selectionFromPlan(params.session, coreRemoved.length, deleted);
  selection.firstRemovedLine = coreRemoved[0]!;
  selection.lastRemovedLine = coreRemoved[coreRemoved.length - 1]!;

  return { selection, toSummarize };
}

async function resolveCodexSessionPath(opts: CodexAutoCompactRunOptions): Promise<string | undefined> {
  if (opts.sessionPath) return opts.sessionPath;

  const { discoverCodexSessionReport } = await import("./session-discovery.js");
  const report = await discoverCodexSessionReport({
    cwd: opts.cwd,
    codexSessionsDir: opts.codexSessionsDir,
    fallback: true,
    lookbackDays: 14,
    maxCandidates: 200,
    tailLines: 500,
    validate: false,
    sessionId: opts.sessionId,
  });
  if (report.agent === "codex" && report.confidence === "high") return report.session.path;
  return undefined;
}

export async function runCodexAutoCompactOnce(opts: CodexAutoCompactRunOptions): Promise<CodexAutoCompactRunResult> {
  const sessionPath = await resolveCodexSessionPath(opts);
  if (!sessionPath) return { result: "no_session", usedModel: opts.model };

  const lockPath = lockPathForSession(sessionPath);
  const lock = await acquireLockWithWait(lockPath, { timeoutMs: opts.busyTimeoutMs });
  if (!lock) return { result: "lock_timeout", usedModel: opts.model, sessionPath };

  try {
    const stable = await waitForStableFile(sessionPath, { timeoutMs: opts.busyTimeoutMs });
    if (!stable) return { result: "busy_timeout", usedModel: opts.model, sessionPath };

    const parsed = await codexAdapter.parse(sessionPath);
    if (!parsed.ok) return { result: "failed", usedModel: opts.model, sessionPath, issues: parsed.issues };

    const tokenCount = extractLastCodexTokenCount(parsed.session);
    const threshold =
      opts.thresholdTokens ?? defaultThresholdFromContextWindow(tokenCount.modelContextWindow);
    const tokens = tokenCount.tokens;

    if (tokens === undefined || threshold === undefined) {
      return {
        result: "failed",
        usedModel: opts.model,
        sessionPath,
        error: "[Codex] Missing token_count info (cannot decide whether to compact).",
      };
    }

    if (tokens < threshold) {
      return { result: "not_triggered", usedModel: opts.model, sessionPath, tokens, threshold };
    }

    const supervisor = readCodexSupervisorEnv();
    if (supervisor) {
      const existingPending = await readCodexPendingCompact(opts.sessionId);
      if (existingPending?.status === "running" || existingPending?.status === "ready") {
        return { result: "pending_ready", usedModel: opts.model, sessionPath, tokens, threshold };
      }
    }

    let removeCount = 0;
    if (opts.amountMode === "tokens") {
      const tokenAmount = parseTokensOrPercent(opts.amountRaw);
      const parts = getCodexCompactionParts(parsed.session);
      const plan = planCodexRemovalByTokens({
        responseItems: parts.candidates.map((l) => l.payload),
        amount: tokenAmount,
      });
      removeCount = plan.removeCount;
    } else {
      const amount = parseCountOrPercent(opts.amountRaw);
      const parts = getCodexCompactionParts(parsed.session);
      if (amount.kind === "percent") removeCount = Math.floor(parts.candidates.length * (amount.percent / 100));
      else removeCount = Math.min(amount.count, parts.candidates.length);
    }

    const planOp = compactCodexSession(parsed.session, { kind: "count", count: removeCount }, "__EVS_PENDING__");
    const plan = computeSelectionFromChanges({ session: parsed.session, changes: planOp.changes });
    if (!plan.selection || plan.selection.removeCount <= 0) {
      return { result: "not_triggered", usedModel: opts.model, sessionPath, tokens, threshold };
    }

    const wrapped = parsed.session.lines.filter((l): l is CodexWrappedLine => l.kind === "wrapped");
    const promptLines: string[] = [];
    for (const line of wrapped) {
      if (!plan.toSummarize.has(line.line)) continue;
      if (line.type !== "response_item") continue;
      if (!isJsonObject(line.payload)) continue;
      const formatted = formatCodexResponseItemForPrompt(line.payload);
      if (formatted) promptLines.push(formatted);
    }

    const formattedMessages = promptLines.join("\n\n");
    const sourceLines = formattedMessages.split("\n").length;
    const targetLines = Math.max(20, Math.floor(sourceLines * 0.2));
    const prompt = buildCompactPrompt(formattedMessages, sourceLines, targetLines);

    let usedModel: ModelType = opts.model;
    let summary: string;
    try {
      summary = await generateSummaryFromPrompt(prompt, usedModel);
    } catch (err) {
      const next: ModelType | undefined = usedModel === "haiku" ? "sonnet" : usedModel === "sonnet" ? "opus" : undefined;
      if (!next) throw err;
      usedModel = next;
      summary = await generateSummaryFromPrompt(prompt, usedModel);
    }

    // Supervised mode: store pending, then ask supervisor to reload (apply at safe boundary).
    if (supervisor) {
      let source: { mtimeMs?: number; size?: number } | undefined;
      try {
        const st = await fs.stat(sessionPath);
        source = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        source = undefined;
      }

      const ts = new Date().toISOString();
      await writeCodexPendingCompact(opts.sessionId, {
        schemaVersion: 1,
        sessionId: opts.sessionId,
        status: "ready",
        createdAt: ts,
        readyAt: ts,
        thresholdTokens: threshold,
        tokensAtTrigger: tokens,
        amountMode: opts.amountMode,
        amountRaw: opts.amountRaw,
        model: usedModel,
        summary,
        selection: plan.selection,
        ...(source ? { source } : {}),
      });

      if (supervisor.reloadMode === "auto") {
        try {
          await appendSupervisorControlCommand({
            controlDir: supervisor.controlDir,
            command: { ts: new Date().toISOString(), cmd: "reload", reason: "auto_compact_pending_ready" },
          });
        } catch {
          // Best-effort: reload can be manual if control log fails.
        }
      }

      return { result: "pending_ready", usedModel, sessionPath, tokens, threshold };
    }

    // Unsupervised: best-effort apply in-place (caller must restart Codex).
    const compacted = compactCodexSession(parsed.session, { kind: "count", count: plan.selection.removeCount }, summary);
    const postParsed = codexAdapter.parseValues(sessionPath, compacted.nextValues);
    const postIssues = [...postParsed.issues, ...(postParsed.ok ? codexAdapter.validate(postParsed.session) : [])];
    const postErrors = countBySeverity(postIssues).error;

    const preIssues = [...parsed.issues, ...codexAdapter.validate(parsed.session)];
    const preErrors = countBySeverity(preIssues).error;

    if (postErrors > preErrors) {
      return { result: "aborted_validation", usedModel, sessionPath, tokens, threshold, issues: postIssues };
    }

    await createSessionBackup(opts.sessionId, sessionPath);
    await cleanupOldBackups(opts.sessionId, 10);
    await writeFileAtomic(sessionPath, stringifyJsonl(compacted.nextValues));

    return { result: "success", usedModel, sessionPath, tokens, threshold };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: "failed", usedModel: opts.model, sessionPath, error: message };
  } finally {
    await lock.release();
  }
}

export async function applyCodexPendingCompactOnReload(params: {
  sessionId: string;
  sessionPath: string;
  busyTimeoutMs: number;
}): Promise<{ applied: boolean; reason?: string; error?: string }> {
  const pending = await readCodexPendingCompact(params.sessionId);
  if (!pending) return { applied: false, reason: "no_pending" };
  if (pending.status !== "ready") return { applied: false, reason: "not_ready" };

  const summary = pending.summary;
  const selection = pending.selection;
  if (!summary || !selection || !Number.isFinite(selection.removeCount) || selection.removeCount <= 0) {
    try {
      await writeCodexPendingCompact(params.sessionId, {
        ...pending,
        status: "stale",
        failedAt: new Date().toISOString(),
        error: "Invalid pending compact: missing summary/selection/removeCount.",
      });
    } catch {
      // ignore
    }
    return { applied: false, reason: "invalid_pending" };
  }

  const lockPath = lockPathForSession(params.sessionPath);
  const lock = await acquireLockWithWait(lockPath, { timeoutMs: params.busyTimeoutMs });
  if (!lock) return { applied: false, reason: "lock_timeout" };

  try {
    const stable = await waitForStableFile(params.sessionPath, { timeoutMs: params.busyTimeoutMs });
    if (!stable) return { applied: false, reason: "busy_timeout" };

    const parsed = await codexAdapter.parse(params.sessionPath);
    if (!parsed.ok) return { applied: false, reason: "parse_failed" };

    const preIssues = [...parsed.issues, ...codexAdapter.validate(parsed.session)];
    const preErrors = countBySeverity(preIssues).error;

    // Verify selection still matches the current file at the reload boundary.
    const selectionPlanOp = compactCodexSession(parsed.session, { kind: "count", count: selection.removeCount }, "__EVS_PENDING__");
    const derived = computeSelectionFromChanges({ session: parsed.session, changes: selectionPlanOp.changes }).selection;
    if (!selectionMatches(selection, derived)) {
      try {
        await writeCodexPendingCompact(params.sessionId, {
          ...pending,
          status: "stale",
          failedAt: new Date().toISOString(),
          error: "Selection mismatch at reload boundary; aborting apply.",
        });
      } catch {
        // ignore
      }
      return { applied: false, reason: "selection_mismatch" };
    }

    const op = compactCodexSession(parsed.session, { kind: "count", count: selection.removeCount }, summary);
    const postParsed = codexAdapter.parseValues(params.sessionPath, op.nextValues);
    const postIssues = [...postParsed.issues, ...(postParsed.ok ? codexAdapter.validate(postParsed.session) : [])];
    const postErrors = countBySeverity(postIssues).error;

    if (postErrors > preErrors) {
      return { applied: false, reason: "aborted_validation" };
    }

    await createSessionBackup(params.sessionId, params.sessionPath);
    await cleanupOldBackups(params.sessionId, 10);
    await writeFileAtomic(params.sessionPath, stringifyJsonl(op.nextValues));

    await clearCodexPendingCompact(params.sessionId);

    return { applied: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: false, reason: "failed", error: message };
  } finally {
    await lock.release();
  }
}
