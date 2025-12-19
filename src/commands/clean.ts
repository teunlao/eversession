import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { getAdapterForDetect, type AgentAdapter } from "../agents/registry.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { compareErrorCounts, printChangesHuman, printIssuesHuman } from "./common.js";
import { looksLikeSessionRef, resolveSessionPathForCli } from "./session-ref.js";

function parseKeywords(input: string): string[] {
  return input
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

export function registerCleanCommand(program: Command): void {
  program
    .command("clean")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (optional when running inside Claude Code)")
    .argument("[keywords]", 'comma-separated keywords (e.g. "token,password")')
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
        const parsedArgs = (): { idArg?: string; keywordsRaw?: string } => {
          if (a !== undefined && b !== undefined) return { idArg: a, keywordsRaw: b };
          if (a !== undefined && b === undefined) {
            return looksLikeSessionRef(a) ? { idArg: a } : { keywordsRaw: a };
          }
          return {};
        };

        const { idArg, keywordsRaw } = parsedArgs();
        if (keywordsRaw === undefined) {
          process.stderr.write('[evs clean] Missing <keywords>. Example: evs clean "token,password"\n');
          process.exitCode = 2;
          return;
        }

        const resolved = await resolveSessionPathForCli({ commandLabel: "clean", idArg });
        if (!resolved.ok) {
          process.stderr.write(resolved.error + "\n");
          process.exitCode = resolved.exitCode;
          return;
        }
        const sessionPath = resolved.value.sessionPath;

        const keywords = parseKeywords(keywordsRaw);
        if (keywords.length === 0) {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.clean_missing_keywords",
              message: '[Core] `clean` requires a non-empty keywords string like "token,password".',
              location: { kind: "file", path: sessionPath },
            },
          ];
          if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
          else printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

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

        const adapter = getAdapterForDetect(detected) as AgentAdapter<unknown> | undefined;
        if (!adapter) {
          process.exitCode = 2;
          return;
        }

        if (!adapter.clean) {
          process.stderr.write(`[${adapter.id}] clean is not supported.\n`);
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

        const cleaned = adapter.clean(parsed.session, { keywords, preserveTurns: opts.preserveTurns });
        if (cleaned.matched === 0 || !cleaned.op) {
          const report = { agent: adapter.id, changes: { changes: [] }, wrote: false, matched: 0 };
          if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          else process.stdout.write("Nothing matches.\n");
          process.exitCode = 0;
          return;
        }

        const op = cleaned.op;
        const preIssues = [...parsed.issues, ...adapter.validate(parsed.session)];

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
          matched: cleaned.matched,
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
