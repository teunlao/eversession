import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import { countBySeverity } from "../core/issues.js";
import { resolveSessionForCli } from "./session-ref.js";

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Summarize a session (format/tokens/structure; not lint)")
    .argument("[id]", "session id or .jsonl path (omit under evs supervisor)")
    .option("--agent <agent>", "claude|codex (optional; only needed when id is ambiguous)")
    .action(async (id: string | undefined, opts: { agent?: string }) => {
      const resolved = await resolveSessionForCli({ commandLabel: "analyze", refArg: id, agent: opts.agent });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }
      const sessionPath = resolved.value.sessionPath;

      const detected = await detectSession(sessionPath);
      if (detected.agent === "unknown") {
        process.stdout.write("unknown\n");
        for (const note of detected.notes) process.stdout.write(`- ${note}\n`);
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
        process.stderr.write("[evs analyze] Failed to parse session. Run `evs lint` for details.\n");
        process.exitCode = 1;
        return;
      }

      const issues = [...parsed.issues, ...adapter.validate(parsed.session)];
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

      for (const line of detail.summary) process.stdout.write(line + "\n");
      const c = report.issueCounts;
      process.stdout.write(`issues: errors=${c.error} warnings=${c.warning} info=${c.info}\n`);
      process.exitCode = 0;
    });
}
