import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { getAdapterForDetect } from "../agents/registry.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity } from "../core/issues.js";
import { hasErrors, printChangesHuman, printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .requiredOption("--to <target>", "migration target (only: codex-wrapped)")
    .option("--dry-run", "show changes but do not write")
    .option("--no-backup", "do not create a backup")
    .option("--force", "write even if post-validation fails")
    .option("--json", "output JSON report")
    .action(
      async (
        id: string | undefined,
        opts: { to: string; dryRun?: boolean; backup?: boolean; force?: boolean; json?: boolean },
      ) => {
        const resolved = await resolveSessionPathForCli({ commandLabel: "migrate", idArg: id });
        if (!resolved.ok) {
          process.stderr.write(resolved.error + "\n");
          process.exitCode = resolved.exitCode;
          return;
        }
        const sessionPath = resolved.value.sessionPath;

        if (opts.to !== "codex-wrapped") {
          process.stderr.write("Only --to codex-wrapped is supported in v0.1.\n");
          process.exitCode = 2;
          return;
        }

        const detected = await detectSession(sessionPath);
        if (detected.agent !== "codex" || detected.format !== "legacy") {
          process.stderr.write("This migrate target expects a Codex legacy session file.\n");
          process.exitCode = 2;
          return;
        }

        const adapter = getAdapterForDetect(detected);
        if (!adapter || adapter.id !== "codex") {
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

        const migrated = adapter.migrate?.(parsed.session, { to: "codex-wrapped" });
        if (!migrated) {
          process.exitCode = 1;
          return;
        }

        const postParsed = adapter.parseValues(sessionPath, migrated.nextValues);
        const postIssues = [
          ...postParsed.issues,
          ...(postParsed.ok ? adapter.validate(postParsed.session) : []),
        ];
        const postHasErrors = hasErrors(postIssues);
        const aborted = postHasErrors && opts.force !== true && opts.dryRun !== true;

        const report = {
          changes: migrated.changes,
          wrote: !opts.dryRun && !aborted,
          post: countBySeverity(postIssues),
          aborted,
        };
        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else {
          printChangesHuman(migrated.changes, { limit: 20 });
          if (postHasErrors) {
            process.stderr.write("\nPost-validation failed (has errors). Use --force to write anyway.\n");
          }
        }

        if (opts.dryRun) return;
        if (aborted) {
          process.exitCode = 1;
          return;
        }
        if (opts.backup !== false) await createBackup(sessionPath);
        await writeFileAtomic(sessionPath, stringifyJsonl(migrated.nextValues));
      },
    );
}
