import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { getAdapterForDetect, type AgentAdapter } from "../agents/registry.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { parseLineSpec } from "../core/spec.js";
import { compareErrorCounts, printChangesHuman, printIssuesHuman } from "./common.js";
import { looksLikeSessionRef, resolveSessionPathForCli } from "./session-ref.js";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (optional when running inside Claude Code)")
    .argument("[lines]", "line spec (e.g. 1,2,5-7)")
    .option("--no-preserve-turns", "do not expand to full assistant turns (Claude only)")
    .option("--dry-run", "show changes but do not write")
    .option("--no-backup", "do not create a backup")
    .option("--force", "write even if post-validation is worse")
    .option("--json", "output JSON report")
    .action(
      async (
        a: string | undefined,
        b: string | undefined,
        opts: { preserveTurns?: boolean; dryRun?: boolean; backup?: boolean; force?: boolean; json?: boolean },
      ) => {
        const parsedArgs = (): { idArg?: string; linesRaw?: string } => {
          if (a && b) return { idArg: a, linesRaw: b };
          if (a && !b) {
            return looksLikeSessionRef(a) ? { idArg: a } : { linesRaw: a };
          }
          return {};
        };

        const { idArg, linesRaw } = parsedArgs();
        if (!linesRaw) {
          process.stderr.write("[evs remove] Missing <lines>. Example: evs remove 1,2,5-7\n");
          process.exitCode = 2;
          return;
        }

        const resolved = await resolveSessionPathForCli({ commandLabel: "remove", idArg });
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

        const lines = new Set(parseLineSpec(linesRaw));

        const adapter = getAdapterForDetect(detected) as AgentAdapter<unknown> | undefined;
        if (!adapter) {
          process.exitCode = 2;
          return;
        }

        const parsed = await adapter.parse(sessionPath);
        if (!parsed.ok) {
          if (opts.json) process.stdout.write(JSON.stringify({ issues: parsed.issues }, null, 2) + "\n");
          else printIssuesHuman(parsed.issues);
          process.exitCode = 1;
          return;
        }

        const session = parsed.session;
        const preIssues = [...parsed.issues, ...adapter.validate(session)];
        const op = adapter.remove?.(session, {
          lines,
          options: {
            preserveAssistantTurns: opts.preserveTurns ?? true,
            preserveCallPairs: true,
          },
        });
        if (!op) {
          process.exitCode = 1;
          return;
        }

        const postParsed = adapter.parseValues(sessionPath, op.nextValues);
        const postIssues = [
          ...postParsed.issues,
          ...(postParsed.ok ? adapter.validate(postParsed.session) : []),
        ];

        const delta = compareErrorCounts(preIssues, postIssues);
        const worsened = delta.after > delta.before;
        const aborted = worsened && opts.force !== true && opts.dryRun !== true;

        const report = {
          agent: adapter.id,
          changes: op.changes,
          wrote: !opts.dryRun && !aborted,
          pre: countBySeverity(preIssues),
          post: countBySeverity(postIssues),
          aborted,
        };

        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else {
          printChangesHuman(op.changes, { limit: 50 });
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
        await writeFileAtomic(sessionPath, stringifyJsonl(op.nextValues));
      },
    );
}
