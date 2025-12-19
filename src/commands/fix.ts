import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import type { AgentId } from "../agents/agent-id.js";
import { getAdapterForDetect, type AgentAdapter } from "../agents/registry.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import type { ChangeSet } from "../core/changes.js";
import { compareErrorCounts, hasErrors, printChangesHuman, printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerFixCommand(program: Command): void {
  program
    .command("fix")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option(
      "--insert-aborted-outputs",
      "insert synthetic aborted outputs for missing tool calls (Codex only; unsafe)",
    )
    .option("--dry-run", "show changes but do not write")
    .option("--no-backup", "do not create a backup")
    .option("--force", "write even if post-validation is worse")
    .option("--hard", "strip all thinking blocks (last resort for stubborn API errors)")
    .option("--json", "output JSON report")
    .action(
      async (
        id: string | undefined,
        opts: {
          insertAbortedOutputs?: boolean;
          dryRun?: boolean;
          backup?: boolean;
          force?: boolean;
          hard?: boolean;
          json?: boolean;
        },
      ) => {
        const resolved = await resolveSessionPathForCli({ commandLabel: "fix", idArg: id });
        if (!resolved.ok) {
          process.stderr.write(resolved.error + "\n");
          process.exitCode = resolved.exitCode;
          return;
        }
        const sessionPath = resolved.value.sessionPath;

        const detected = await detectSession(sessionPath);
        if (detected.agent === "unknown") {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.unknown_format",
              message: "[Core] Failed to detect session format.",
              location: { kind: "file", path: sessionPath },
            },
          ];
          if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
          else printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

        const runFix = async (): Promise<
          | {
              kind: "ok";
              agent: AgentId;
              nextValues: unknown[];
              changes: ChangeSet;
              preIssues: Issue[];
              postIssues: Issue[];
            }
          | { kind: "error"; issues: Issue[] }
        > => {
          const adapter = getAdapterForDetect(detected) as AgentAdapter<unknown> | undefined;
          if (!adapter) {
            return {
              kind: "error",
              issues: [
                {
                  severity: "error",
                  code: "core.unknown_format",
                  message: "[Core] Failed to detect session format.",
                  location: { kind: "file", path: sessionPath },
                },
              ],
            };
          }

          const parsed = await adapter.parse(sessionPath);
          if (!parsed.ok) return { kind: "error", issues: parsed.issues };
          const preIssues = [...parsed.issues, ...adapter.validate(parsed.session)];
          const fixed = adapter.fix?.(parsed.session, {
            stripThinkingBlocks: opts.hard ?? false,
            insertAbortedOutputs: opts.insertAbortedOutputs ?? false,
          });
          if (!fixed) return { kind: "error", issues: parsed.issues };
          const postParsed = adapter.parseValues(sessionPath, fixed.nextValues);
          const postIssues = [
            ...postParsed.issues,
            ...(postParsed.ok ? adapter.validate(postParsed.session) : []),
          ];
          return {
            kind: "ok",
            agent: adapter.id,
            nextValues: fixed.nextValues,
            changes: fixed.changes,
            preIssues,
            postIssues,
          };
        };

        const out = await runFix();
        if (out.kind === "error") {
          if (opts.json) process.stdout.write(JSON.stringify({ issues: out.issues }, null, 2) + "\n");
          else printIssuesHuman(out.issues);
          process.exitCode = 1;
          return;
        }

        const delta = compareErrorCounts(out.preIssues, out.postIssues);
        const worsened = delta.after > delta.before;
        const aborted = worsened && opts.force !== true && opts.dryRun !== true;
        const report = {
          agent: out.agent,
          changes: out.changes,
          wrote: !opts.dryRun && !aborted,
          pre: countBySeverity(out.preIssues),
          post: countBySeverity(out.postIssues),
          aborted,
        };

        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        } else {
          printChangesHuman(out.changes);
          if (worsened) {
            process.stderr.write(
              `\nPost-validation errors increased (${delta.before} → ${delta.after}). Use --force to write anyway.\n`,
            );
          }
        }

        if (opts.dryRun) return;
        if (aborted) {
          process.exitCode = 1;
          return;
        }

        if (opts.backup !== false) await createBackup(sessionPath);
        await writeFileAtomic(sessionPath, stringifyJsonl(out.nextValues));
        process.exitCode = hasErrors(out.postIssues) ? 1 : 0;
      },
    );
}
