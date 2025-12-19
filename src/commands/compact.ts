import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { getAdapterForDetect, type AgentAdapter } from "../agents/registry.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { stringifyJsonl, readTextFile } from "../core/jsonl.js";
import { compareErrorCounts, printChangesHuman, printIssuesHuman } from "./common.js";
import { looksLikeSessionRef, resolveSessionPathForCli } from "./session-ref.js";

export function registerCompactCommand(program: Command): void {
  program
    .command("compact")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (optional when running inside Claude Code)")
    .argument("[amount]", "number of messages/items or percent (e.g. 50 or 20%)")
    .option("--amount-messages <n|%>", "amount to compact by messages (overrides positional amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (Claude only)")
    .option("-m, --model <model>", "generate summary via LLM (haiku|sonnet|opus)")
    .option("--summary <text>", "summary text to inject (manual mode)")
    .option("--summary-file <path>", "read summary text from file")
    .option("--keep-last", "keep last N items instead of compacting first N")
    .option("--dry-run", "show changes but do not write")
    .option("--no-backup", "do not create a backup")
    .option("--force", "write even if post-validation is worse")
    .option("--json", "output JSON report")
    .action(
      async (
        a: string | undefined,
        b: string | undefined,
        opts: {
          amountMessages?: string;
          amountTokens?: string;
          model?: string;
          summary?: string;
          summaryFile?: string;
          keepLast?: boolean;
          dryRun?: boolean;
          backup?: boolean;
          force?: boolean;
          json?: boolean;
        },
      ) => {
        const defaultAmount = "25%";
        const parsedArgs = (): { idArg?: string; amountRaw: string } => {
          if (a && b) return { idArg: a, amountRaw: b };
          if (a && !b) {
            return looksLikeSessionRef(a) ? { idArg: a, amountRaw: defaultAmount } : { amountRaw: a };
          }
          return { amountRaw: defaultAmount };
        };

        const { idArg, amountRaw } = parsedArgs();

        const resolved = await resolveSessionPathForCli({ commandLabel: "compact", idArg });
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

        let summary: string | undefined;
        if (opts.summaryFile && opts.summaryFile.length > 0) {
          summary = (await readTextFile(opts.summaryFile)).trim();
        } else if (opts.summary) {
          summary = opts.summary;
        }

        const amountTokensRaw = opts.amountTokens?.trim();
        const amountMessagesRaw = opts.amountMessages?.trim();
        if (amountTokensRaw && amountMessagesRaw) {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.compact_invalid_amount_mode",
              message: "[Core] Use either --amount-messages or --amount-tokens (not both).",
              location: { kind: "file", path: sessionPath },
            },
          ];
          if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
          else printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

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

        if (!adapter.prepareCompact) {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.compact_unsupported_agent",
              message: "[Core] `compact` supports Claude and Codex sessions only.",
              location: { kind: "file", path: sessionPath },
            },
          ];
          if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
          else printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

        const prepareParams: {
          amountRaw: string;
          amountMessagesRaw?: string;
          amountTokensRaw?: string;
          keepLast?: boolean;
          summary?: string;
          model?: string;
          json?: boolean;
          log?: (line: string) => void;
        } = { amountRaw };
        if (amountMessagesRaw) prepareParams.amountMessagesRaw = amountMessagesRaw;
        if (amountTokensRaw) prepareParams.amountTokensRaw = amountTokensRaw;
        if (opts.keepLast !== undefined) prepareParams.keepLast = opts.keepLast;
        if (summary !== undefined) prepareParams.summary = summary;
        if (opts.model !== undefined) prepareParams.model = opts.model;
        if (opts.json !== undefined) prepareParams.json = opts.json;
        if (!opts.json) prepareParams.log = (line: string) => process.stdout.write(line + "\n");

        const prepared = await adapter.prepareCompact(parsed.session, prepareParams);
        if (!prepared.ok) {
          if (opts.json) process.stdout.write(JSON.stringify({ issues: prepared.issues }, null, 2) + "\n");
          else printIssuesHuman(prepared.issues);
          process.exitCode = prepared.exitCode ?? 2;
          return;
        }

        const preIssues = [...parsed.issues, ...adapter.validate(parsed.session)];
        const op = adapter.compact?.(parsed.session, {
          amount: prepared.plan.amount,
          summary: prepared.plan.summary,
          options: prepared.plan.options,
        });
        if (!op) {
          process.exitCode = 1;
          return;
        }

        const postParsed = adapter.parseValues(sessionPath, op.nextValues);
        let finalValues = op.nextValues;
        let combinedChanges = op.changes;
        let finalParsed = postParsed;

        if (prepared.plan.postFixParams && postParsed.ok && adapter.fix) {
          const postFixed = adapter.fix(postParsed.session, prepared.plan.postFixParams);
          finalValues = postFixed.nextValues;
          combinedChanges = { changes: [...op.changes.changes, ...postFixed.changes.changes] };
          finalParsed = adapter.parseValues(sessionPath, finalValues);
        }

        const postIssues = [
          ...finalParsed.issues,
          ...(finalParsed.ok ? adapter.validate(finalParsed.session) : []),
        ];

        const delta = compareErrorCounts(preIssues, postIssues);
        const worsened = delta.after > delta.before;
        const aborted = worsened && opts.force !== true && opts.dryRun !== true;

        const report = {
          agent: adapter.id,
          changes: combinedChanges,
          wrote: !opts.dryRun && !aborted,
          pre: countBySeverity(preIssues),
          post: countBySeverity(postIssues),
          aborted,
        };

        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else {
          printChangesHuman(combinedChanges, { limit: 50 });
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
        await writeFileAtomic(sessionPath, stringifyJsonl(finalValues));
      },
    );
}
