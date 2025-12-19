import * as fs from "node:fs/promises";

import { claudeAdapter } from "../../agents/claude/adapter.js";
import type { ClaudeEntryLine } from "../../agents/claude/session.js";
import { generateClaudeSummary, type ModelType } from "../../agents/claude/summary.js";
import { getChainEntries, getChainMessages, getEntryType, getUuid } from "../../agents/claude/model.js";
import { countClaudeMessagesTokens, planClaudeRemovalByTokens } from "../../agents/claude/tokens.js";
import { expandToPreserveToolPairs } from "../../agents/claude/remove-utils.js";
import { expandToFullAssistantTurns } from "../../agents/claude/turns.js";
import { writeFileAtomic } from "../../core/fs.js";
import { stringifyJsonl } from "../../core/jsonl.js";
import { parseCountOrPercent, parseTokensOrPercent, type CountOrPercent } from "../../core/spec.js";
import { acquireLockWithWait } from "../../core/lock.js";
import { waitForStableFile } from "../../core/file-stability.js";
import { countBySeverity, type Issue } from "../../core/issues.js";
import { sendOsNotification } from "../../core/notify.js";
import { deriveSessionIdFromPath, lockPathForSession } from "../../core/paths.js";
import { resolveClaudeSessionPathFromInputs } from "./active-session.js";
import { readClaudeSupervisorEnv } from "./supervisor-control.js";
import {
  appendSessionLog,
  cleanupOldBackups,
  createSessionBackup,
  updateSessionState,
} from "./eversession-session-storage.js";
import {
  clearPendingCompact,
  readPendingCompact,
  writePendingCompact,
  type PendingCompactSelection,
} from "./pending-compact.js";

export type AutoCompactResult =
  | "not_triggered"
  | "success"
  | "pending_ready"
  | "failed"
  | "busy_timeout"
  | "lock_timeout"
  | "aborted_guard"
  | "aborted_validation"
  | "no_session";

export type AutoCompactAmountMode = "messages" | "tokens";

export type AutoCompactRunOptions = {
  cwd: string;
  sessionPath?: string;
  thresholdTokens: number;
  amountMode: AutoCompactAmountMode;
  amountRaw: string;
  keepLastRaw?: string;
  model: ModelType;
  busyTimeoutMs: number;
  notify?: boolean;
};

export type AutoCompactRunResult = {
  result: AutoCompactResult;
  tokens?: number;
  tokensAfter?: number;
  usedModel: ModelType;
  issues?: Issue[];
  error?: string;
  sessionPath?: string;
};

function modelRankUp(model: ModelType): ModelType | undefined {
  if (model === "haiku") return "sonnet";
  if (model === "sonnet") return "opus";
  return undefined;
}

export function isClaudeAutoCompactModel(value: string | undefined): value is ModelType {
  return value === "haiku" || value === "sonnet" || value === "opus";
}

function effectiveAmount(amountRaw: string, keepLastRaw: string | undefined): { amount: CountOrPercent; keepLast: boolean } {
  if (keepLastRaw && keepLastRaw.trim().length > 0) {
    const keep = parseCountOrPercent(keepLastRaw);
    if (keep.kind !== "count") throw new Error("[AutoCompact] --keep-last requires an integer count (percent not supported).");
    return { amount: keep, keepLast: true };
  }
  return { amount: parseCountOrPercent(amountRaw), keepLast: false };
}

function isRootUserEntry(entry: ClaudeEntryLine): boolean {
  if (getEntryType(entry) !== "user") return false;
  return entry.value.parentUuid === null || entry.value.parentUuid === undefined;
}

function getAutoCompactVisibleMessages(entries: ClaudeEntryLine[]): ClaudeEntryLine[] {
  const chainMessages = getChainMessages(entries);
  const metaRootUser = entries.find((e) => isRootUserEntry(e) && e.value.isMeta === true);
  if (metaRootUser && !chainMessages.some((m) => m.line === metaRootUser.line)) {
    return [metaRootUser, ...chainMessages];
  }
  return chainMessages;
}

function computePendingSelection(entries: ClaudeEntryLine[], removeCount: number): PendingCompactSelection | undefined {
  if (!Number.isFinite(removeCount) || removeCount <= 0) return undefined;
  const visibleMessages = getAutoCompactVisibleMessages(entries);

  const requested = new Set<number>(visibleMessages.slice(0, removeCount).map((e) => e.line));
  expandToFullAssistantTurns(entries, requested);
  const reasons = expandToPreserveToolPairs(entries, requested);
  const toRemove = new Set<number>(reasons.keys());

  const chainEntries = getChainEntries(entries);
  const metaRootUser = entries.find((e) => isRootUserEntry(e) && e.value.isMeta === true);
  const rootUser = metaRootUser ?? chainEntries.find(isRootUserEntry) ?? entries.find(isRootUserEntry);
  if (rootUser) toRemove.delete(rootUser.line);

  let firstRemovedUuid: string | undefined;
  let lastRemovedUuid: string | undefined;
  for (const m of visibleMessages) {
    if (!toRemove.has(m.line)) continue;
    const uuid = getUuid(m);
    if (uuid) {
      firstRemovedUuid = uuid;
      break;
    }
  }
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const m = visibleMessages[i];
    if (!m || !toRemove.has(m.line)) continue;
    const uuid = getUuid(m);
    if (uuid) {
      lastRemovedUuid = uuid;
      break;
    }
  }

  let anchorUuid: string | undefined;
  for (const m of visibleMessages) {
    if (toRemove.has(m.line)) continue;
    if (rootUser && m.line === rootUser.line) continue;
    const uuid = getUuid(m);
    if (uuid) {
      anchorUuid = uuid;
      break;
    }
  }

  return {
    removeCount,
    ...(firstRemovedUuid ? { firstRemovedUuid } : {}),
    ...(lastRemovedUuid ? { lastRemovedUuid } : {}),
    ...(anchorUuid ? { anchorUuid } : {}),
  };
}

export async function runClaudeAutoCompactOnce(opts: AutoCompactRunOptions): Promise<AutoCompactRunResult> {
  const sessionPath =
    opts.sessionPath ??
    (await resolveClaudeSessionPathFromInputs({
      cwd: opts.cwd,
      allowDiscover: true,
    }));
  if (!sessionPath) {
    // No session to log to
    return { result: "no_session", usedModel: opts.model };
  }

  const sessionId = deriveSessionIdFromPath(sessionPath);
  const lockPath = lockPathForSession(sessionPath);

  const supervisor = readClaudeSupervisorEnv();
  const lock = await acquireLockWithWait(lockPath, { timeoutMs: opts.busyTimeoutMs });
  if (!lock) {
    await appendSessionLog(sessionId, {
      event: "auto_compact",
      sessionPath,
      result: "lock_timeout",
      busyTimeoutMs: opts.busyTimeoutMs,
    });
    return { result: "lock_timeout", usedModel: opts.model, sessionPath };
  }

  try {
    const stable = await waitForStableFile(sessionPath, { timeoutMs: opts.busyTimeoutMs });
    if (!stable) {
      await appendSessionLog(sessionId, {
        event: "auto_compact",
        sessionPath,
        result: "busy_timeout",
        busyTimeoutMs: opts.busyTimeoutMs,
      });
      return { result: "busy_timeout", usedModel: opts.model, sessionPath };
    }

    let stableKey: string | undefined;
    try {
      const st = await fs.stat(sessionPath);
      stableKey = `${st.mtimeMs}:${st.size}`;
    } catch {
      stableKey = undefined;
    }

    const parsed = await claudeAdapter.parse(sessionPath);
    if (!parsed.ok) throw new Error("[AutoCompact] Failed to parse session.");

    const repaired = claudeAdapter.fix?.(parsed.session, { removalMode: "tombstone" });
    if (!repaired) throw new Error("[AutoCompact] Failed to repair session.");
    const repairedParsed = claudeAdapter.parseValues(sessionPath, repaired.nextValues);
    if (!repairedParsed.ok) throw new Error("[AutoCompact] Failed to parse repaired session values.");
    const repairedIssues = [
      ...repairedParsed.issues,
      ...(repairedParsed.ok ? claudeAdapter.validate(repairedParsed.session) : []),
    ];
    const repairedErrorCount = countBySeverity(repairedIssues).error;

    const tokens = await countClaudeMessagesTokens(repairedParsed.session);
    if (tokens < opts.thresholdTokens) {
      await appendSessionLog(sessionId, {
        event: "auto_compact",
        sessionPath,
        result: "not_triggered",
        amountMode: opts.amountMode,
        amount: opts.amountRaw,
        keepLast: opts.keepLastRaw ?? null,
        tokens,
        threshold: opts.thresholdTokens,
      });
      return { result: "not_triggered", tokens, usedModel: opts.model, sessionPath };
    }

    const existingPending = await readPendingCompact(sessionId);
    if (supervisor && (existingPending?.status === "running" || existingPending?.status === "ready")) {
      await appendSessionLog(sessionId, {
        event: "auto_compact",
        sessionPath,
        result: "pending_ready",
        mode: "precompute",
        reason: "skipped_existing_pending",
        threshold: opts.thresholdTokens,
        tokens,
      });
      return { result: "pending_ready", tokens, usedModel: opts.model, sessionPath };
    }

    const entries = repairedParsed.session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
    const visibleMessages = getAutoCompactVisibleMessages(entries);

    let keepLast = false;
    let amount: CountOrPercent;
    let removeCount = 0;
    let targetRemoveTokens: number | undefined;
    let selectedRemoveTokens: number | undefined;

    if (opts.amountMode === "tokens") {
      if (opts.keepLastRaw && opts.keepLastRaw.trim().length > 0) {
        throw new Error("[AutoCompact] --amount-tokens cannot be combined with --keep-last.");
      }
      const tokenAmount = parseTokensOrPercent(opts.amountRaw);
      const plan = await planClaudeRemovalByTokens({ visibleMessages, amount: tokenAmount });
      removeCount = plan.removeCount;
      targetRemoveTokens = plan.targetRemoveTokens;
      selectedRemoveTokens = plan.selectedRemoveTokens;
      amount = { kind: "count", count: removeCount };
    } else {
      const resolved = effectiveAmount(opts.amountRaw, opts.keepLastRaw);
      amount = resolved.amount;
      keepLast = resolved.keepLast;

      if (keepLast) {
        if (amount.kind !== "count") throw new Error("[AutoCompact] internal keep-last requires count.");
        removeCount = Math.max(0, visibleMessages.length - amount.count);
      } else if (amount.kind === "percent") {
        removeCount = Math.floor(visibleMessages.length * (amount.percent / 100));
      } else {
        removeCount = Math.min(amount.count, visibleMessages.length);
      }
    }

    const entriesToCompact = visibleMessages.slice(0, removeCount);
    const pendingSelection = computePendingSelection(entries, removeCount);

    const trySummary = async (model: ModelType): Promise<string> => {
      const result = await generateClaudeSummary(repairedParsed.session!, entriesToCompact, { model });
      return result.summary;
    };

    let usedModel: ModelType = opts.model;
    let summary: string;
    try {
      summary = await trySummary(opts.model);
    } catch (err) {
      const next = modelRankUp(opts.model);
      if (!next) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendSessionLog(sessionId, {
          event: "auto_compact",
          sessionPath,
          result: "failed",
          stage: "llm_summary",
          model: opts.model,
          error: msg,
        });
        return { result: "failed", tokens, usedModel: opts.model, error: msg, sessionPath };
      }
      try {
        usedModel = next;
        summary = await trySummary(next);
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        await appendSessionLog(sessionId, {
          event: "auto_compact",
          sessionPath,
          result: "failed",
          stage: "llm_summary",
          model: usedModel,
          error: msg,
        });
        return { result: "failed", tokens, usedModel, error: msg, sessionPath };
      }
    }

    const op = claudeAdapter.compact?.(repairedParsed.session, {
      amount,
      summary,
      options: { keepLast, preserveAssistantTurns: true, removalMode: "tombstone" },
    });
    if (!op) throw new Error("[AutoCompact] Failed to compact session.");
    const postParsed = claudeAdapter.parseValues(sessionPath, op.nextValues);
    const postIssues = [...postParsed.issues, ...(postParsed.ok ? claudeAdapter.validate(postParsed.session) : [])];

    const preErrors = repairedErrorCount;
    const postErrors = countBySeverity(postIssues).error;

    let finalValues = op.nextValues;
    let postFixChanges = 0;
    let finalErrors = postErrors;

    if (postErrors > 0) {
      if (!postParsed.ok) throw new Error("[AutoCompact] Failed to parse compacted session values.");
      const postFixed = claudeAdapter.fix?.(postParsed.session, { removalMode: "tombstone" });
      if (!postFixed) throw new Error("[AutoCompact] Failed to fix compacted session.");
      postFixChanges = postFixed.changes.changes.length;
      const postFixedParsed = claudeAdapter.parseValues(sessionPath, postFixed.nextValues);
      const postFixedIssues = [
        ...postFixedParsed.issues,
        ...(postFixedParsed.ok ? claudeAdapter.validate(postFixedParsed.session) : []),
      ];
      finalErrors = countBySeverity(postFixedIssues).error;

      if (finalErrors > preErrors) {
        await appendSessionLog(sessionId, {
          event: "auto_compact",
          sessionPath,
          result: "aborted_validation",
          tokens,
          threshold: opts.thresholdTokens,
          model: usedModel,
          preErrors,
          postErrors,
          postFixErrors: finalErrors,
          postFixChanges,
        });
        return { result: "aborted_validation", tokens, usedModel, issues: postFixedIssues, sessionPath };
      }

      finalValues = postFixed.nextValues;
    }

    // Supervised mode: do NOT write while Claude is running.
    // Store a pending compact, to be applied at the reload boundary (supervisor stops child first).
    if (supervisor) {
      let source: { mtimeMs?: number; size?: number } | undefined;
      try {
        const st = await fs.stat(sessionPath);
        source = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        source = undefined;
      }

      const ts = new Date().toISOString();

      await writePendingCompact(sessionId, {
        schemaVersion: 1,
        sessionId,
        status: "ready",
        createdAt: ts,
        readyAt: ts,
        thresholdTokens: opts.thresholdTokens,
        tokensAtTrigger: tokens,
        amountMode: opts.amountMode,
        amountRaw: opts.amountRaw,
        ...(opts.keepLastRaw ? { keepLastRaw: opts.keepLastRaw } : {}),
        model: usedModel,
        summary,
        ...(pendingSelection ? { selection: pendingSelection } : {}),
        ...(source ? { source } : {}),
      });

      await appendSessionLog(sessionId, {
        event: "auto_compact",
        sessionPath,
        result: "pending_ready",
        mode: "precompute",
        supervisorReloadMode: supervisor.reloadMode,
        amountMode: opts.amountMode,
        tokens,
        threshold: opts.thresholdTokens,
        amount: opts.amountRaw,
        keepLast: opts.keepLastRaw ?? null,
        ...(targetRemoveTokens !== undefined ? { targetRemoveTokens } : {}),
        ...(selectedRemoveTokens !== undefined ? { selectedRemoveTokens } : {}),
        ...(removeCount > 0 ? { removeCount } : {}),
        model: usedModel,
        changes: op.changes.changes.length,
        repairedChanges: repaired.changes.changes.length,
        preErrors,
        postErrors,
        finalErrors,
        postFixChanges,
      });

      if (supervisor.reloadMode === "auto") {
        try {
          await updateSessionState(sessionId, { pendingReload: { ts, reason: "auto_compact_pending_ready" } });
          await appendSessionLog(sessionId, { event: "auto_reload", sessionPath, result: "armed", mode: "auto" });
        } catch {
          // Best-effort: never fail hooks because of session state persistence.
        }
      }

      return { result: "pending_ready", tokens, usedModel, sessionPath };
    }

    if (stableKey) {
      try {
        const st = await fs.stat(sessionPath);
        const currentKey = `${st.mtimeMs}:${st.size}`;
        if (currentKey !== stableKey) {
          await appendSessionLog(sessionId, {
            event: "auto_compact",
            sessionPath,
            result: "aborted_guard",
            stage: "guard_mismatch",
            amountMode: opts.amountMode,
            tokens,
            threshold: opts.thresholdTokens,
            amount: opts.amountRaw,
            keepLast: opts.keepLastRaw ?? null,
            model: usedModel,
            stableKey,
            currentKey,
          });
          return { result: "aborted_guard", tokens, usedModel, sessionPath };
        }
      } catch {
        // Ignore stat errors; fall back to best-effort write path.
      }
    }

    // Create backup in new storage location
    const backupPath = await createSessionBackup(sessionId, sessionPath);
    await cleanupOldBackups(sessionId, 10);

    await writeFileAtomic(sessionPath, stringifyJsonl(finalValues));

    const finalParsed = claudeAdapter.parseValues(sessionPath, finalValues);
    const tokensAfter = finalParsed.ok ? await countClaudeMessagesTokens(finalParsed.session) : undefined;

    await appendSessionLog(sessionId, {
      event: "auto_compact",
      sessionPath,
      result: "success",
      supervisorReloadMode: null,
      amountMode: opts.amountMode,
      tokens,
      tokensAfter: tokensAfter ?? null,
      threshold: opts.thresholdTokens,
      amount: opts.amountRaw,
      keepLast: opts.keepLastRaw ?? null,
      ...(targetRemoveTokens !== undefined ? { targetRemoveTokens } : {}),
      ...(selectedRemoveTokens !== undefined ? { selectedRemoveTokens } : {}),
      ...(removeCount > 0 ? { removeCount } : {}),
      model: usedModel,
      backupPath,
      changes: op.changes.changes.length,
      repairedChanges: repaired.changes.changes.length,
      preErrors,
      postErrors,
      finalErrors,
      postFixChanges,
    });

    if (opts.notify) {
      const msgParts = [
        `session=${sessionId}`,
        `tokens=${tokens}${tokensAfter !== undefined ? `→${tokensAfter}` : ""}`,
        `amount=${opts.amountRaw}`,
        `model=${usedModel}`,
      ];
      await sendOsNotification({ title: "evs auto-compact", message: msgParts.join(" ") });
    }

    // Store compact info in session state (survives supervisor restart)
    // - Always store lastCompact (useful for cleanup/status/debug), regardless of reload mode.
    // - Only arm pendingReload when reloadMode=auto.
    const compactTs = new Date().toISOString();
    const tokensAfterForState = tokensAfter ?? tokens;
    try {
      await updateSessionState(sessionId, {
        lastCompact: { ts: compactTs, tokensBefore: tokens, tokensAfter: tokensAfterForState, model: usedModel },
      });
    } catch {
      // Best-effort: do not fail the hook if we cannot persist lastCompact.
    }

    return {
      result: "success",
      tokens,
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
      usedModel,
      sessionPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendSessionLog(sessionId, {
      event: "auto_compact",
      sessionPath,
      result: "failed",
      stage: "exception",
      amountMode: opts.amountMode,
      amount: opts.amountRaw,
      keepLast: opts.keepLastRaw ?? null,
      error: msg,
    });
    return { result: "failed", usedModel: opts.model, error: msg, sessionPath };
  } finally {
    await lock.release();
  }
}

function selectionMatches(params: { pending: PendingCompactSelection; current: PendingCompactSelection | undefined }): boolean {
  const pending = params.pending;
  const current = params.current;
  if (!current) return false;
  if (pending.removeCount !== current.removeCount) return false;

  if (pending.firstRemovedUuid && pending.firstRemovedUuid !== current.firstRemovedUuid) return false;
  if (pending.lastRemovedUuid && pending.lastRemovedUuid !== current.lastRemovedUuid) return false;
  if (pending.anchorUuid && pending.anchorUuid !== current.anchorUuid) return false;

  return true;
}

export type ApplyPendingCompactResult =
  | { applied: false; reason: "no_pending" | "not_ready" | "invalid_pending" | "selection_mismatch"; error?: string }
  | { applied: true; tokensBefore: number; tokensAfter?: number; usedModel: string; sessionPath: string };

export async function applyClaudePendingCompactOnReload(params: {
  sessionId: string;
  sessionPath: string;
  busyTimeoutMs: number;
}): Promise<ApplyPendingCompactResult> {
  const pending = await readPendingCompact(params.sessionId);
  if (!pending) return { applied: false, reason: "no_pending" };
  if (pending.status !== "ready") return { applied: false, reason: "not_ready" };

  const summary = pending.summary;
  const selection = pending.selection;
  if (!summary || !selection || !Number.isFinite(selection.removeCount) || selection.removeCount <= 0) {
    try {
      await writePendingCompact(params.sessionId, {
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
  if (!lock) {
    return { applied: false, reason: "selection_mismatch", error: "Failed to acquire lock for apply." };
  }

  try {
    const stable = await waitForStableFile(params.sessionPath, { timeoutMs: params.busyTimeoutMs });
    if (!stable) {
      return { applied: false, reason: "selection_mismatch", error: "Session file not stable for apply." };
    }

    const parsed = await claudeAdapter.parse(params.sessionPath);
    if (!parsed.ok) throw new Error("[AutoCompact] Failed to parse session for apply.");

    const repaired = claudeAdapter.fix?.(parsed.session, { removalMode: "tombstone" });
    if (!repaired) throw new Error("[AutoCompact] Failed to repair session for apply.");
    const repairedParsed = claudeAdapter.parseValues(params.sessionPath, repaired.nextValues);
    if (!repairedParsed.ok) throw new Error("[AutoCompact] Failed to parse repaired session values for apply.");

    const repairedIssues = [
      ...repairedParsed.issues,
      ...(repairedParsed.ok ? claudeAdapter.validate(repairedParsed.session) : []),
    ];
    const repairedErrorCount = countBySeverity(repairedIssues).error;

    const tokensBefore = await countClaudeMessagesTokens(repairedParsed.session);

    const entries = repairedParsed.session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");
    const currentSelection = computePendingSelection(entries, selection.removeCount);
    if (!selectionMatches({ pending: selection, current: currentSelection })) {
      try {
        await writePendingCompact(params.sessionId, {
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

    const op = claudeAdapter.compact?.(repairedParsed.session, {
      amount: { kind: "count", count: selection.removeCount },
      summary,
      options: { keepLast: false, preserveAssistantTurns: true, removalMode: "tombstone" },
    });
    if (!op) throw new Error("[AutoCompact] Failed to compact session on apply.");

    const postParsed = claudeAdapter.parseValues(params.sessionPath, op.nextValues);
    const postIssues = [...postParsed.issues, ...(postParsed.ok ? claudeAdapter.validate(postParsed.session) : [])];
    const postErrors = countBySeverity(postIssues).error;

    let finalValues = op.nextValues;
    let postFixChanges = 0;
    let finalErrors = postErrors;

    if (postErrors > 0) {
      if (!postParsed.ok) throw new Error("[AutoCompact] Failed to parse compacted session values on apply.");
      const postFixed = claudeAdapter.fix?.(postParsed.session, { removalMode: "tombstone" });
      if (!postFixed) throw new Error("[AutoCompact] Failed to fix compacted session on apply.");
      postFixChanges = postFixed.changes.changes.length;
      const postFixedParsed = claudeAdapter.parseValues(params.sessionPath, postFixed.nextValues);
      const postFixedIssues = [
        ...postFixedParsed.issues,
        ...(postFixedParsed.ok ? claudeAdapter.validate(postFixedParsed.session) : []),
      ];
      finalErrors = countBySeverity(postFixedIssues).error;

      if (finalErrors > repairedErrorCount) {
        await appendSessionLog(params.sessionId, {
          event: "auto_compact",
          sessionPath: params.sessionPath,
          result: "aborted_validation",
          stage: "apply",
          tokens: tokensBefore,
          threshold: pending.thresholdTokens ?? null,
          model: pending.model ?? null,
          preErrors: repairedErrorCount,
          postErrors,
          postFixErrors: finalErrors,
          postFixChanges,
        });
        return { applied: false, reason: "selection_mismatch", error: "Validation worsened after apply; aborted." };
      }

      finalValues = postFixed.nextValues;
    }

    const backupPath = await createSessionBackup(params.sessionId, params.sessionPath);
    await cleanupOldBackups(params.sessionId, 10);

    await writeFileAtomic(params.sessionPath, stringifyJsonl(finalValues));

    const finalParsed = claudeAdapter.parseValues(params.sessionPath, finalValues);
    const tokensAfter = finalParsed.ok ? await countClaudeMessagesTokens(finalParsed.session) : undefined;

    const supervisor = readClaudeSupervisorEnv();
    const usedModel = pending.model ?? "haiku";

    await appendSessionLog(params.sessionId, {
      event: "auto_compact",
      sessionPath: params.sessionPath,
      result: "success",
      ...(supervisor ? { supervisorReloadMode: supervisor.reloadMode } : { supervisorReloadMode: null }),
      amountMode: pending.amountMode ?? null,
      tokens: tokensBefore,
      tokensAfter: tokensAfter ?? null,
      threshold: pending.thresholdTokens ?? null,
      amount: pending.amountRaw ?? null,
      keepLast: pending.keepLastRaw ?? null,
      ...(selection.removeCount > 0 ? { removeCount: selection.removeCount } : {}),
      model: usedModel,
      backupPath,
      changes: op.changes.changes.length,
      repairedChanges: repaired.changes.changes.length,
      preErrors: repairedErrorCount,
      postErrors,
      finalErrors,
      postFixChanges,
    });

    try {
      await updateSessionState(params.sessionId, {
        pendingReload: null,
        lastCompact: {
          ts: new Date().toISOString(),
          tokensBefore,
          tokensAfter: tokensAfter ?? tokensBefore,
          model: usedModel,
        },
      });
    } catch {
      // ignore
    }

    await clearPendingCompact(params.sessionId);

    return {
      applied: true,
      tokensBefore,
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
      usedModel,
      sessionPath: params.sessionPath,
    };
  } finally {
    await lock.release();
  }
}
