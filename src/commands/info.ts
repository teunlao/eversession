import type { Command } from "commander";
import { buildClaudeInfoReport } from "../integrations/claude/info.js";
import { isClaudeHookInvocation } from "../integrations/claude/context.js";
import { resolveClaudeActiveSession } from "../integrations/claude/active-session.js";
import type { Issue } from "../core/issues.js";
import { readClaudeHookInputIfAny } from "../integrations/claude/hook-input.js";
import { printIssuesHuman } from "./common.js";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("Show info for the active Claude session for this project (for hooks/status)")
    .option("--cwd <path>", "target working directory (default: process.cwd())")
    .option("--claude-projects-dir <dir>", "override ~/.claude/projects (advanced)")
    .option("--json", "output JSON report")
    .action(async (opts: { cwd?: string; claudeProjectsDir?: string; json?: boolean }) => {
      const hook = await readClaudeHookInputIfAny(25);
      const isHookInvocation = isClaudeHookInvocation(hook);
      const resolved = await resolveClaudeActiveSession({
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.claudeProjectsDir ? { claudeProjectsDir: opts.claudeProjectsDir } : {}),
        ...(hook ? { hook } : {}),
        allowDiscover: true,
        validate: true,
      });

      if ("error" in resolved) {
        if (resolved.issues && opts.json) {
          process.stdout.write(JSON.stringify({ agent: "unknown", cwd: opts.cwd ?? process.cwd(), issues: resolved.issues }, null, 2) + "\n");
          process.exitCode = isHookInvocation ? 0 : 2;
          return;
        }
        const issues: Issue[] = [
          {
            severity: "error",
            code: "claude.session_not_found",
            message: "[Claude] No active session was provided by hooks, and discovery failed.",
            location: { kind: "file", path: opts.cwd ?? process.cwd() },
          },
        ];
        if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
        else printIssuesHuman(issues);
        process.exitCode = isHookInvocation ? 0 : 2;
        return;
      }

      const sessionPath = resolved.sessionPath;
      const sessionId = resolved.sessionId;
      const method = resolved.method;
      const confidence = resolved.confidence;
      const mtime = resolved.mtime;
      const lastActivity = resolved.lastActivity;

      if (!sessionPath || !sessionId) {
        const issues: Issue[] = [
          {
            severity: "error",
            code: "claude.session_not_found",
            message: "[Claude] No active session was provided by hooks, and discovery failed.",
            location: { kind: "file", path: opts.cwd ?? process.cwd() },
          },
        ];
        if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
        else printIssuesHuman(issues);
        process.exitCode = isHookInvocation ? 0 : 2;
        return;
      }

      const infoParams: {
        cwd: string;
        sessionPath: string;
        sessionId: string;
        method?: string;
        confidence?: string;
        mtime?: string;
        lastActivity?: string;
        isHookInvocation?: boolean;
      } = {
        cwd: resolved.cwd,
        sessionPath,
        sessionId,
        isHookInvocation,
      };
      if (method) infoParams.method = method;
      if (confidence) infoParams.confidence = confidence;
      if (mtime) infoParams.mtime = mtime;
      if (lastActivity) infoParams.lastActivity = lastActivity;

      const result = await buildClaudeInfoReport(infoParams);
      if (!result.ok) {
        if (opts.json) process.stdout.write(JSON.stringify({ issues: result.issues }, null, 2) + "\n");
        else printIssuesHuman(result.issues);
        process.exitCode = result.exitCode;
        return;
      }

      const report = result.report;
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        process.exitCode = result.exitCode;
        return;
      }

      const status = report.issueCounts.error > 0 ? "WARN" : "OK";
      process.stdout.write(
        `[evs] ${status} ${report.analysis.visibleMessages} visible_messages | ~${Math.round(report.tokens / 1000)}k tokens | errors=${report.issueCounts.error} warnings=${report.issueCounts.warning}\n`,
      );
      process.stdout.write(`[evs] session=${sessionPath} method=${method} confidence=${confidence}\n`);
      process.exitCode = result.exitCode;
    });
}

// deriveSessionIdFromPath lives in core/paths.ts
