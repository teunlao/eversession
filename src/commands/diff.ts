import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
import { type DiffLine, type DiffOp, patienceDiff, summarizeDiff } from "../core/diff.js";
import { loadJsonlFile } from "../core/jsonl.js";
import { getClaudeCentralBackupsDir, resolveClaudeCentralBackup } from "../integrations/claude/diff.js";
import { resolveSessionPathForCli } from "./session-ref.js";

async function resolveAgainst(sessionPath: string, against: string | undefined): Promise<string | undefined> {
  if (against) return against;

  const siblingBackup = await resolveSiblingBackup(sessionPath);
  const centralBackup = await resolveClaudeCentralBackup(sessionPath);

  if (!siblingBackup) return centralBackup;
  if (!centralBackup) return siblingBackup;

  const [siblingMtime, centralMtime] = await Promise.all([
    tryStatMtimeMs(siblingBackup),
    tryStatMtimeMs(centralBackup),
  ]);
  if (siblingMtime !== undefined && centralMtime !== undefined) {
    return siblingMtime >= centralMtime ? siblingBackup : centralBackup;
  }

  // Best-effort fallback
  return siblingBackup;
}

async function resolveSiblingBackup(sessionPath: string): Promise<string | undefined> {
  const dir = dirname(sessionPath);
  const base = basename(sessionPath);
  const prefix = `${base}.backup-`;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const backups = entries
      .filter((e) => e.isFile() && e.name.startsWith(prefix))
      .map((e) => e.name)
      .sort();

    const last = backups[backups.length - 1];
    return last ? join(dir, last) : undefined;
  } catch {
    return undefined;
  }
}

async function tryStatMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const st = await stat(filePath);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}

async function loadNormalizedLines(path: string): Promise<DiffLine[]> {
  const jsonl = await loadJsonlFile(path);
  return jsonl.map((line) => ({
    line: line.line,
    text: line.kind === "json" ? JSON.stringify(line.value) : line.raw.trim(),
  }));
}

function formatExcerpt(text: string, maxLen: number): string {
  const t = text.replaceAll(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

function toJsonChange(op: DiffOp): Record<string, unknown> {
  if (op.kind === "equal") {
    return { kind: op.kind, aLine: op.aLine, bLine: op.bLine, text: op.text };
  }
  if (op.kind === "delete") {
    return { kind: op.kind, aLine: op.aLine, text: op.text };
  }
  return { kind: op.kind, bLine: op.bLine, text: op.text };
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .argument("[id]", "session path (*.jsonl) or Claude session UUID (defaults to active session when omitted)")
    .option(
      "--against <path>",
      "path to compare against (defaults to latest backup next to session or in EverSession storage)",
    )
    .option("--limit <n>", "limit the number of shown changes (default: 50)", "50")
    .option("--json", "output JSON report")
    .action(async (id: string | undefined, opts: { against?: string; limit: string; json?: boolean }) => {
      const resolved = await resolveSessionPathForCli({ commandLabel: "diff", idArg: id });
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n");
        process.exitCode = resolved.exitCode;
        return;
      }
      const sessionPath = resolved.value.sessionPath;

      const against = await resolveAgainst(sessionPath, opts.against);
      if (!against) {
        const msg = `No --against provided and no backup file found (checked next to target and ${getClaudeCentralBackupsDir(sessionPath)}).\n`;
        if (opts.json) process.stdout.write(JSON.stringify({ error: msg.trim() }, null, 2) + "\n");
        else process.stderr.write(msg);
        process.exitCode = 2;
        return;
      }

      const limit = Number(opts.limit);
      const shown = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;

      const aLines = await loadNormalizedLines(against);
      const bLines = await loadNormalizedLines(sessionPath);
      const ops = patienceDiff(aLines, bLines);
      const summary = summarizeDiff(ops);
      const changes = ops.filter((o) => o.kind !== "equal");
      const hasChanges = changes.length > 0;

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              a: against,
              b: sessionPath,
              summary,
              hasChanges,
              changes: changes.slice(0, shown).map(toJsonChange),
              truncated: changes.length > shown,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write(`a=${against}\n`);
        process.stdout.write(`b=${sessionPath}\n`);
        process.stdout.write(`summary: equal=${summary.equal} insert=${summary.insert} delete=${summary.delete}\n`);
        if (changes.length === 0) {
          process.stdout.write("no changes\n");
        } else {
          process.stdout.write(`changes: ${changes.length}\n`);
          for (const op of changes.slice(0, shown)) {
            if (op.kind === "delete") {
              process.stdout.write(`- ${op.aLine}: ${formatExcerpt(op.text, 140)}\n`);
            } else {
              process.stdout.write(`+ ${op.bLine}: ${formatExcerpt(op.text, 140)}\n`);
            }
          }
          if (changes.length > shown) process.stdout.write(`… (${changes.length - shown} more)\n`);
        }
      }

      process.exitCode = hasChanges ? 1 : 0;
    });
}
