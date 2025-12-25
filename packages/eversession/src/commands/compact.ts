import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { readTextFile, stringifyJsonl } from "../core/jsonl.js";
import { resolveEvsConfigForCwd } from "../core/project-config.js";
import { compareErrorCounts, printChangesHuman, printIssuesHuman } from "./common.js";
import { looksLikeSessionRef, resolveSessionForCli } from "./session-ref.js";

export function registerCompactCommand(program: Command): void {
  program
    .command("compact")
    .description("Compact the current session (manual)")
    .argument("[ref]", "session id or .jsonl path (omit under evs supervisor)")
    .argument("[amount]", "messages/items to compact (e.g. 50 or 20%)")
    .option("--agent <agent>", "claude|codex (optional; only needed when id is ambiguous)")
    .option("--amount-messages <n|%>", "amount to compact by messages (overrides positional amount)")
    .option("--amount-tokens <n|%|k>", "amount to compact by tokens (Claude only)")
    .option("-m, --model <model>", "LLM model (haiku|sonnet|opus)")
    .option("--summary <text>", "summary text to inject (skips LLM)")
    .option("--summary-file <path>", "read summary text from file")
    .option("--keep-last", "keep last N items instead of compacting first N")
    .option("--dry-run", "show changes but do not write")
    .option("--backup", "create a backup before writing")
    .option("--force", "write even if post-validation is worse")
    .action(
      async (
        a: string | undefined,
        b: string | undefined,
        opts: {
          agent?: string;
          amountMessages?: string;
          amountTokens?: string;
          model?: string;
          summary?: string;
          summaryFile?: string;
          keepLast?: boolean;
          dryRun?: boolean;
          backup?: boolean;
          force?: boolean;
        },
      ) => {
        const parsedArgs = (): { refArg?: string; amountArg?: string } => {
          if (a && b) return { refArg: a, amountArg: b };
          if (a && !b) {
            return looksLikeSessionRef(a) ? { refArg: a } : { amountArg: a };
          }
          return {};
        };

        const { refArg, amountArg } = parsedArgs();

        const resolved = await resolveSessionForCli({ commandLabel: "compact", refArg, agent: opts.agent });
        if (!resolved.ok) {
          process.stderr.write(resolved.error + "\n");
          process.exitCode = resolved.exitCode;
          return;
        }
        const sessionPath = resolved.value.sessionPath;
        const agent = resolved.value.agent;

        const cfg = await resolveEvsConfigForCwd(process.cwd());
        const agentCfg = agent === "claude" ? cfg.config.claude : cfg.config.codex;
        const auto = agentCfg?.autoCompact;

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
          printIssuesHuman(issues);
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
          printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

        const defaultModel = auto?.model?.trim();
        const model = opts.model?.trim() ?? (defaultModel && defaultModel.length > 0 ? defaultModel : undefined);

        const defaultAmountMessages = auto?.amountMessages?.trim();
        const fallbackAmountMessages = agent === "codex" ? "35%" : "25%";
        const effectiveMessagesAmount =
          amountArg?.trim() ??
          (defaultAmountMessages && defaultAmountMessages.length > 0 ? defaultAmountMessages : fallbackAmountMessages);

        const defaultAmountTokens = agent === "claude" ? auto?.amountTokens?.trim() : undefined;
        const effectiveAmountTokens =
          amountTokensRaw ??
          (amountMessagesRaw || amountArg ? undefined : defaultAmountTokens && defaultAmountTokens.length > 0 ? defaultAmountTokens : undefined);

        const adapter = getAdapterForDetect(detected) as AgentAdapter<unknown> | undefined;
        if (!adapter) {
          process.exitCode = 2;
          return;
        }

        const parsed = await adapter.parse(sessionPath);
        if (!parsed.ok) {
          printIssuesHuman(parsed.issues);
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
          printIssuesHuman(issues);
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
          log?: (line: string) => void;
        } = { amountRaw: effectiveMessagesAmount };
        if (amountMessagesRaw) prepareParams.amountMessagesRaw = amountMessagesRaw;
        if (effectiveAmountTokens) prepareParams.amountTokensRaw = effectiveAmountTokens;
        if (opts.keepLast !== undefined) prepareParams.keepLast = opts.keepLast;
        if (summary !== undefined) prepareParams.summary = summary;
        if (model !== undefined) prepareParams.model = model;
        prepareParams.log = (line: string) => process.stdout.write(line + "\n");

        const prepared = await adapter.prepareCompact(parsed.session, prepareParams);
        if (!prepared.ok) {
          printIssuesHuman(prepared.issues);
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

        const postIssues = [...finalParsed.issues, ...(finalParsed.ok ? adapter.validate(finalParsed.session) : [])];

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

        printChangesHuman(combinedChanges, { limit: 50 });
        if (worsened) {
          process.stderr.write(
            `\nPost-validation errors increased (${delta.before} → ${delta.after}). Use --force to write anyway.\n`,
          );
        }

        if (opts.dryRun) return;
        if (aborted) {
          process.exitCode = 1;
          return;
        }

        const backupEnabled = opts.backup ?? cfg.config.backup ?? false;
        if (backupEnabled) await createBackup(sessionPath);
        await writeFileAtomic(sessionPath, stringifyJsonl(finalValues));
      },
    );
}
