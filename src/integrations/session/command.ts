import * as path from "node:path";

import type { SessionDiscoveryReport, SessionHit } from "../../agents/session-discovery/types.js";
import type { Issue } from "../../core/issues.js";
import { printIssuesHuman } from "../../core/cli.js";
import { readClaudeHookInputIfAny } from "../claude/hook-input.js";
import { resolveClaudeActiveSession, toClaudeSessionDiscoveryReport } from "../claude/active-session.js";
import { discoverClaudeSessionReport, type ClaudeDiscoveryOptions } from "../claude/session-discovery.js";
import { defaultClaudeProjectsDir } from "../claude/paths.js";
import { discoverCodexSessionReport, type CodexDiscoveryOptions } from "../codex/session-discovery.js";
import { defaultCodexSessionsDir } from "../codex/paths.js";

type AgentChoice = "auto" | "claude" | "codex";

type DiscoveryOptions = {
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
  includeSidechains: boolean;
  validate: boolean;
};

async function discoverSession(opts: DiscoveryOptions): Promise<SessionDiscoveryReport> {
  if (opts.agent === "claude") {
    const claudeOpts: ClaudeDiscoveryOptions = {
      cwd: opts.cwd,
      claudeProjectsDir: opts.claudeProjectsDir,
      // Claude Code sessions are project-scoped; cross-project fallback is not useful and can be harmful.
      fallback: false,
      maxCandidates: opts.maxCandidates,
      tailLines: opts.tailLines,
      includeSidechains: opts.includeSidechains,
      validate: opts.validate,
    };
    if (opts.sessionId) claudeOpts.sessionId = opts.sessionId;
    if (opts.match) claudeOpts.match = opts.match;
    return discoverClaudeSessionReport(claudeOpts);
  }

  if (opts.agent === "codex") {
    const codexOpts: CodexDiscoveryOptions = {
      cwd: opts.cwd,
      codexSessionsDir: opts.codexSessionsDir,
      fallback: opts.fallback,
      lookbackDays: opts.lookbackDays,
      maxCandidates: opts.maxCandidates,
      tailLines: opts.tailLines,
      validate: opts.validate,
    };
    if (opts.sessionId) codexOpts.sessionId = opts.sessionId;
    if (opts.match) codexOpts.match = opts.match;
    return discoverCodexSessionReport(codexOpts);
  }

  const claudeOpts: ClaudeDiscoveryOptions = {
    cwd: opts.cwd,
    claudeProjectsDir: opts.claudeProjectsDir,
    // Claude Code sessions are project-scoped; keep discovery within this project only.
    fallback: false,
    maxCandidates: opts.maxCandidates,
    tailLines: opts.tailLines,
    includeSidechains: opts.includeSidechains,
    validate: opts.validate,
  };
  if (opts.sessionId) claudeOpts.sessionId = opts.sessionId;
  if (opts.match) claudeOpts.match = opts.match;
  const claude = await discoverClaudeSessionReport(claudeOpts);
  if (claude.agent !== "unknown") return claude;

  const codexOpts: CodexDiscoveryOptions = {
    cwd: opts.cwd,
    codexSessionsDir: opts.codexSessionsDir,
    fallback: opts.fallback,
    lookbackDays: opts.lookbackDays,
    maxCandidates: opts.maxCandidates,
    tailLines: opts.tailLines,
    validate: opts.validate,
  };
  if (opts.sessionId) codexOpts.sessionId = opts.sessionId;
  if (opts.match) codexOpts.match = opts.match;
  const codex = await discoverCodexSessionReport(codexOpts);
  if (codex.agent !== "unknown") return codex;

  return {
    agent: "unknown",
    cwd: opts.cwd,
    issues: [...claude.issues, ...codex.issues],
    alternatives: [],
  };
}

function pickExitCodeForReport(report: SessionDiscoveryReport): number {
  if (report.agent === "unknown") return 2;
  const errs = report.session.health?.validationErrors ?? 0;
  return errs > 0 ? 1 : 0;
}

function printHookLine(hit: SessionHit): void {
  const health = hit.health;
  const errs = health?.validationErrors ?? 0;
  const warns = health?.validationWarnings ?? 0;
  const status = errs > 0 ? "WARN" : "OK";
  const name = hit.path ? path.basename(hit.path) : "unknown";
  process.stdout.write(`[evs] ${status} agent=${hit.agent} session=${name} errors=${errs} warnings=${warns}\n`);
}

export type SessionCommandOptions = {
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
  includeSidechains?: boolean;
  validate?: boolean;
  hook?: boolean;
  json?: boolean;
};

export async function runSessionCommand(opts: SessionCommandOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const agent = (opts.agent ?? "auto") as AgentChoice;
  if (agent !== "auto" && agent !== "claude" && agent !== "codex") {
    const issues: Issue[] = [
      {
        severity: "error",
        code: "core.invalid_agent",
        message: `[Core] Invalid --agent value: ${opts.agent} (expected auto|claude|codex).`,
        location: { kind: "file", path: cwd },
      },
    ];
    if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
    else printIssuesHuman(issues);
    process.exitCode = 2;
    return;
  }

  const canUseExecutionContext = !opts.cwd && !opts.sessionId && !opts.match && (agent === "auto" || agent === "claude");
  if (canUseExecutionContext) {
    const hook = await readClaudeHookInputIfAny(25);
    const resolved = await resolveClaudeActiveSession({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.claudeProjectsDir ? { claudeProjectsDir: opts.claudeProjectsDir } : {}),
      ...(hook ? { hook } : {}),
      allowDiscover: false,
      validate: false,
    });
    if (!("error" in resolved)) {
      const report = toClaudeSessionDiscoveryReport(resolved);
      if (report.agent === "unknown") {
        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          process.exitCode = 2;
          return;
        }
        printIssuesHuman(report.issues);
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        process.exitCode = 0;
        return;
      }

      if (opts.hook) {
        printHookLine(report.session);
        process.exitCode = 0;
        return;
      }

      const hit = report.session;
      process.stdout.write(`agent=${report.agent} method=${report.method} confidence=${report.confidence}\n`);
      process.stdout.write(`cwd=${report.cwd}\n`);
      process.stdout.write(`path=${hit.path}\n`);
      if (hit.id) process.stdout.write(`id=${hit.id}\n`);
      if (hit.projectHash) process.stdout.write(`projectHash=${hit.projectHash}\n`);
      if (hit.mtime) process.stdout.write(`mtime=${hit.mtime}\n`);
      process.exitCode = 0;
      return;
    }
  }

  const fallback = opts.fallback !== "off";
  const lookbackDays = Number(opts.lookbackDays);
  const maxCandidates = Number(opts.maxCandidates);
  const tailLines = Number(opts.tailLines);

  const discoveryOpts: DiscoveryOptions = {
    agent,
    cwd,
    fallback,
    lookbackDays: Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : 14,
    maxCandidates: Number.isFinite(maxCandidates) && maxCandidates > 0 ? Math.floor(maxCandidates) : 200,
    tailLines: Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : 500,
    claudeProjectsDir: opts.claudeProjectsDir ?? defaultClaudeProjectsDir(),
    codexSessionsDir: opts.codexSessionsDir ?? defaultCodexSessionsDir(),
    includeSidechains: opts.includeSidechains ?? false,
    validate: opts.validate ?? false,
  };
  if (opts.sessionId) discoveryOpts.sessionId = opts.sessionId;
  if (opts.match) discoveryOpts.match = opts.match;

  const discovered = await discoverSession(discoveryOpts);
  const report: SessionDiscoveryReport =
    discovered.agent === "unknown"
      ? discovered
      : {
          ...discovered,
          // `evs session` is intentionally strict: do not suggest alternatives in output.
          alternatives: [],
        };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.agent === "unknown" ? 2 : report.confidence === "high" ? pickExitCodeForReport(report) : 2;
    return;
  }

  if (report.agent === "unknown") {
    printIssuesHuman(report.issues);
    process.exitCode = 2;
    return;
  }

  if (report.confidence !== "high") {
    process.stderr.write("[evs session] Cannot determine current session with high confidence (ambiguous).\n");
    process.stderr.write("Pass an explicit id:\n  evs session --session-id <uuid>\n");
    process.exitCode = 2;
    return;
  }

  if (opts.hook) {
    printHookLine(report.session);
    process.exitCode = pickExitCodeForReport(report);
    return;
  }

  const hit = report.session;
  process.stdout.write(`agent=${report.agent} method=${report.method} confidence=${report.confidence}\n`);
  process.stdout.write(`cwd=${report.cwd}\n`);
  process.stdout.write(`path=${hit.path}\n`);
  if (hit.id) process.stdout.write(`id=${hit.id}\n`);
  if (hit.projectHash) process.stdout.write(`projectHash=${hit.projectHash}\n`);
  if (hit.lastActivity) process.stdout.write(`lastActivity=${hit.lastActivity}\n`);
  if (hit.mtime) process.stdout.write(`mtime=${hit.mtime}\n`);
  if (hit.sidechains && hit.sidechains.length > 0) process.stdout.write(`sidechains=${hit.sidechains.length}\n`);
  if (hit.health) {
    process.stdout.write(`health: errors=${hit.health.validationErrors} warnings=${hit.health.validationWarnings}\n`);
  }

  process.exitCode = pickExitCodeForReport(report);
}
