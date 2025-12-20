import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import { createBackup, writeFileAtomic } from "../core/fs.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { stringifyJsonl } from "../core/jsonl.js";
import { compareErrorCounts, printChangesHuman, printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerStripNoiseCommand(program: Command): void {
  program
    .command("strip-noise")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option("--no-drop-turn-context", "do not drop Codex turn_context lines")
    .option("--no-drop-event-msg", "do not drop Codex event_msg lines")
    .option("--no-drop-legacy-state", "do not drop Codex legacy record_type state lines")
    .option("--dry-run", "show changes but do not write")
    .option("--no-backup", "do not create a backup")
    .option("--force", "write even if post-validation is worse")
    .option("--json", "output JSON report")
    .action(
      async (
        id: string | undefined,
        opts: {
          dropTurnContext?: boolean;
          dropEventMsg?: boolean;
          dropLegacyState?: boolean;
          dryRun?: boolean;
          backup?: boolean;
          force?: boolean;
          json?: boolean;
        },
      ) => {
        const resolved = await resolveSessionPathForCli({ commandLabel: "strip-noise", idArg: id });
        if (!resolved.ok) {
          process.stderr.write(resolved.error + "\n");
          process.exitCode = resolved.exitCode;
          return;
        }
        const sessionPath = resolved.value.sessionPath;

        const detected = await detectSession(sessionPath);
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

        if (!adapter.stripNoise) {
          const issues: Issue[] = [
            {
              severity: "error",
              code: "core.strip_noise_requires_codex",
              message: "[Core] `strip-noise` currently supports Codex sessions only.",
              location: { kind: "file", path: sessionPath },
            },
          ];
          if (opts.json) process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
          else printIssuesHuman(issues);
          process.exitCode = 2;
          return;
        }

        const session = parsed.session;
        const preIssues = [...parsed.issues, ...adapter.validate(session)];
        const op = adapter.stripNoise(session, {
          dropTurnContext: opts.dropTurnContext ?? true,
          dropEventMsg: opts.dropEventMsg ?? true,
          dropLegacyState: opts.dropLegacyState ?? true,
        });

        const postParsed = adapter.parseValues(sessionPath, op.nextValues);
        const postIssues = [...postParsed.issues, ...(postParsed.ok ? adapter.validate(postParsed.session) : [])];

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
