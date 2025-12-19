import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { getAdapterForDetect, type AgentAdapter } from "../agents/registry.js";
import { countBySeverity, type Issue } from "../core/issues.js";
import { printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option("--json", "output JSON report")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const resolved = await resolveSessionPathForCli({ commandLabel: "analyze", idArg: id });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }
      const sessionPath = resolved.value.sessionPath;

      const detected = await detectSession(sessionPath);
      if (detected.agent === "unknown") {
        const report = {
          agent: "unknown" as const,
          confidence: detected.confidence,
          notes: detected.notes,
        };
        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else {
          process.stdout.write("unknown\n");
          for (const note of detected.notes) process.stdout.write(`- ${note}\n`);
        }
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

      const issues: Issue[] = [...parsed.issues, ...adapter.validate(parsed.session)];
      const detail = adapter.analyzeDetail
        ? await adapter.analyzeDetail(parsed.session, {})
        : { format: "unknown", analysis: adapter.analyze(parsed.session), summary: [] };
      const report = {
        agent: adapter.id,
        format: detail.format,
        detection: detected,
        analysis: detail.analysis,
        ...(detail.extras ?? {}),
        issueCounts: countBySeverity(issues),
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        for (const line of detail.summary) process.stdout.write(line + "\n");
        const c = report.issueCounts;
        process.stdout.write(`issues: errors=${c.error} warnings=${c.warning} info=${c.info}\n`);
      }
      process.exitCode = report.issueCounts.error > 0 ? 1 : 0;
    });
}
