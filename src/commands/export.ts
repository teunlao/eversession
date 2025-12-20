import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import type { ExportItem } from "../agents/export.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import type { Issue } from "../core/issues.js";
import { hasErrors, printIssuesHuman } from "./common.js";
import { resolveSessionPathForCli } from "./session-ref.js";

function printTextTranscript(items: ExportItem[]): void {
  for (const item of items) {
    if (item.kind === "message") {
      process.stdout.write(`\n--- ${item.role.toUpperCase()}\n`);
      process.stdout.write(item.text.trimEnd() + "\n");
      continue;
    }
    if (item.kind === "compacted") {
      process.stdout.write(`\n--- COMPACTED\n`);
      process.stdout.write(item.text.trimEnd() + "\n");
      continue;
    }
    if (item.kind === "reasoning") {
      process.stdout.write(`\n--- REASONING\n`);
      process.stdout.write(item.text.trimEnd() + "\n");
      continue;
    }
    process.stdout.write(`\n--- TOOL ${item.name}\n`);
    process.stdout.write(item.text.trimEnd() + "\n");
  }
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .requiredOption("--format <format>", "export format: text|json")
    .option("--full", "include non user/assistant items where supported")
    .action(async (id: string | undefined, opts: { format: string; full?: boolean }) => {
      const format = opts.format;
      if (format !== "text" && format !== "json") {
        process.stderr.write("export --format must be one of: text, json\n");
        process.exitCode = 2;
        return;
      }
      const full = opts.full ?? false;

      const resolved = await resolveSessionPathForCli({ commandLabel: "export", idArg: id });
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
        if (format === "json") process.stdout.write(JSON.stringify({ issues }, null, 2) + "\n");
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
        if (format === "json") process.stdout.write(JSON.stringify({ issues: parsed.issues }, null, 2) + "\n");
        else printIssuesHuman(parsed.issues);
        process.exitCode = 1;
        return;
      }

      if (!adapter.export) {
        process.stderr.write(`[${adapter.id}] export is not supported.\n`);
        process.exitCode = 2;
        return;
      }

      const exported = adapter.export(parsed.session, { full });

      if (format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              agent: adapter.id,
              format: exported.format,
              detection: detected,
              issues: parsed.issues,
              items: exported.items,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        if (parsed.issues.length > 0) printIssuesHuman(parsed.issues);
        printTextTranscript(exported.items);
      }
      process.exitCode = hasErrors(parsed.issues) ? 1 : 0;
    });
}
