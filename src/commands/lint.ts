import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import type { ChangeSet } from "../core/changes.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { resolveEvsConfigForCwd } from "../core/project-config.js";
import { compareErrorCounts, hasErrors, printChangesHuman, printIssuesHuman } from "./common.js";
import { resolveSessionForCli } from "./session-ref.js";

export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Validate a session file (use --fix to apply safe fixes)")
    .argument("[ref]", "session id or .jsonl path (omit under evs supervisor)")
    .option("--agent <agent>", "claude|codex (optional; only needed when id is ambiguous)")
    .option("--fix", "apply fixes")
    .option("--dry-run", "show changes but do not write")
    .option("--backup", "create a backup before writing")
    .option("--force", "write even if post-validation is worse")
    .action(
      async (
        refArg: string | undefined,
        opts: {
          agent?: string;
          fix?: boolean;
          dryRun?: boolean;
          backup?: boolean;
          force?: boolean;
        },
      ) => {
        const resolved = await resolveSessionForCli({ commandLabel: "lint", refArg, agent: opts.agent });
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
              details: { notes: detected.notes },
            },
          ];
          printIssuesHuman(issues);
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
          printIssuesHuman(parsed.issues);
          process.exitCode = 1;
          return;
        }

        const preIssues = [...parsed.issues, ...adapter.validate(parsed.session)];
        if (opts.fix !== true) {
          printIssuesHuman(preIssues);
          process.exitCode = hasErrors(preIssues) ? 1 : 0;
          return;
        }

        const cfg = await resolveEvsConfigForCwd(process.cwd());
        const backupEnabled = opts.backup ?? cfg.config.backup ?? false;

        let session = parsed.session;
        let combinedChanges: ChangeSet = { changes: [] };

        if (detected.agent === "codex" && detected.format === "legacy" && adapter.migrate) {
          const migrated = adapter.migrate(session, { to: "codex-wrapped" });
          combinedChanges = { changes: [...combinedChanges.changes, ...migrated.changes.changes] };
          const migratedParsed = adapter.parseValues(sessionPath, migrated.nextValues);
          if (!migratedParsed.ok) {
            printIssuesHuman(migratedParsed.issues);
            process.exitCode = 1;
            return;
          }
          session = migratedParsed.session;
        }

        if (!adapter.fix) {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.fix_unsupported_agent",
              message: "[Core] `lint --fix` is not supported for this session type.",
              location: { kind: "file", path: sessionPath },
            },
          ];
          printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

        const fixed = adapter.fix(session, {});
        combinedChanges = { changes: [...combinedChanges.changes, ...fixed.changes.changes] };
        const finalValues = fixed.nextValues;

        const postParsed = adapter.parseValues(sessionPath, finalValues);
        const postIssues = [...postParsed.issues, ...(postParsed.ok ? adapter.validate(postParsed.session) : [])];

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
        const c = report.post;
        process.stdout.write(`issues: errors=${c.error} warnings=${c.warning} info=${c.info}\n`);
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

        if (backupEnabled) await createBackup(sessionPath);
        await writeFileAtomic(sessionPath, stringifyJsonl(finalValues));
        process.exitCode = hasErrors(postIssues) ? 1 : 0;
      },
    );
}
