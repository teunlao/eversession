import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import type { Issue } from "../core/issues.js";
import { hasErrors, printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option("--json", "output JSON issues report")
    .option("--doctor", "show suggested next steps")
    .action(async (id: string | undefined, opts: { json?: boolean; doctor?: boolean }) => {
      const resolved = await resolveSessionPathForCli({ commandLabel: "validate", idArg: id });
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
        if (opts.json) process.stdout.write(JSON.stringify({ issues, suggestions: [] }, null, 2) + "\n");
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
        if (opts.json) process.stdout.write(JSON.stringify({ issues: parsed.issues, suggestions: [] }, null, 2) + "\n");
        else printIssuesHuman(parsed.issues);
        process.exitCode = 1;
        return;
      }

      const issues = [...parsed.issues, ...adapter.validate(parsed.session)];
      const suggestions = adapter.suggest?.(parsed.session, { path: sessionPath, issues }) ?? [];

      if (opts.json) {
        process.stdout.write(JSON.stringify({ issues, suggestions }, null, 2) + "\n");
      } else {
        printIssuesHuman(issues);
        if (opts.doctor && suggestions.length > 0) {
          process.stdout.write("\nSuggested next steps:\n");
          for (const s of suggestions) process.stdout.write(`  ${s.command}\n    # ${s.reason}\n`);
        }
      }
      process.exitCode = hasErrors(issues) ? 1 : 0;
    });
}
