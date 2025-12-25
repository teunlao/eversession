import type { Command } from "commander";

import { detectSession } from "../agents/detect.js";
import type { ExportItem } from "../agents/export.js";
import { type AgentAdapter, getAdapterForDetect } from "../agents/registry.js";
import type { Issue } from "../core/issues.js";
import { discoverCodexSessionReport } from "../integrations/codex/session-discovery.js";
import { defaultCodexSessionsDir } from "../integrations/codex/paths.js";
import { hasErrors, printIssuesHuman } from "./common.js";
import { isPathLike, resolveSessionPathForCli } from "./session-ref.js";

type ResolveExportSessionResult =
  | { ok: true; sessionPath: string }
  | { ok: false; error: string; exitCode: number };

function resolveSessionsLookbackDays(): number {
  return 14;
}

async function resolveExportSessionPath(params: { commandLabel: string; idArg: string | undefined; cwd: string }): Promise<ResolveExportSessionResult> {
  const idRaw = params.idArg?.trim();

  if (idRaw && idRaw.length > 0) {
    if (isPathLike(idRaw)) {
      const resolvedPath = await resolveSessionPathForCli({
        commandLabel: params.commandLabel,
        idArg: idRaw,
        cwd: params.cwd,
        allowDiscover: false,
      });
      if (!resolvedPath.ok) return { ok: false, error: resolvedPath.error, exitCode: resolvedPath.exitCode };
      return { ok: true, sessionPath: resolvedPath.value.sessionPath };
    }

    const claudeResolved = await resolveSessionPathForCli({
      commandLabel: params.commandLabel,
      idArg: idRaw,
      cwd: params.cwd,
      allowDiscover: false,
    });

    const codexReport = await discoverCodexSessionReport({
      cwd: params.cwd,
      codexSessionsDir: defaultCodexSessionsDir(),
      fallback: true,
      lookbackDays: resolveSessionsLookbackDays(),
      maxCandidates: 200,
      tailLines: 500,
      validate: false,
      sessionId: idRaw,
    });

    const claudePath = claudeResolved.ok ? claudeResolved.value.sessionPath : undefined;
    const codexPath =
      codexReport.agent === "codex" && codexReport.confidence === "high" ? codexReport.session.path : undefined;

    if (claudePath && codexPath) {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Session id matches both Claude and Codex. Pass a .jsonl path instead.`,
      };
    }
    if (claudePath) return { ok: true, sessionPath: claudePath };
    if (codexPath) return { ok: true, sessionPath: codexPath };

    return {
      ok: false,
      exitCode: 2,
      error: `[evs ${params.commandLabel}] No session found for id=${idRaw}. Pass a .jsonl path instead.`,
    };
  }

  // Prefer Claude only when there is explicit hook/env context.
  const claudeContext = await resolveSessionPathForCli({
    commandLabel: params.commandLabel,
    cwd: params.cwd,
    allowDiscover: false,
  });
  if (claudeContext.ok) return { ok: true, sessionPath: claudeContext.value.sessionPath };

  const codex = await discoverCodexSessionReport({
    cwd: params.cwd,
    codexSessionsDir: defaultCodexSessionsDir(),
    fallback: true,
    lookbackDays: resolveSessionsLookbackDays(),
    maxCandidates: 200,
    tailLines: 500,
    validate: false,
  });
  if (codex.agent === "codex") {
    if (codex.confidence !== "high") {
      return {
        ok: false,
        exitCode: 2,
        error: `[evs ${params.commandLabel}] Cannot determine current Codex session with high confidence (ambiguous). Pass a session id or .jsonl path.`,
      };
    }
    return { ok: true, sessionPath: codex.session.path };
  }

  const claudeDiscover = await resolveSessionPathForCli({
    commandLabel: params.commandLabel,
    cwd: params.cwd,
    allowDiscover: true,
  });
  if (claudeDiscover.ok) return { ok: true, sessionPath: claudeDiscover.value.sessionPath };

  return { ok: false, exitCode: 2, error: `[evs ${params.commandLabel}] No session found. Pass a .jsonl path or session id.` };
}

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
    .argument("[id]", "session path (*.jsonl), Claude UUID, or Codex session id (defaults to active session when omitted)")
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

      const cwd = process.cwd();
      const resolved = await resolveExportSessionPath({ commandLabel: "export", idArg: id, cwd });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }
      const sessionPath = resolved.sessionPath;

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
