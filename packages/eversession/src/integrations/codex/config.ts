import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createBackup, fileExists, writeFileAtomic } from "../../core/fs.js";

export const EVS_CODEX_NOTIFY_COMMAND = ["evs", "codex", "notify"] as const;

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured && configured.length > 0) return configured;
  return path.join(os.homedir(), ".codex");
}

export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), "config.toml");
}

type NotifyEditResult =
  | { kind: "noop"; reason: "already_installed" | "not_installed" }
  | { kind: "changed"; content: string };

function stripInlineTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";

    if (inDouble) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "#") return line.slice(0, i).trimEnd();
  }

  return line.trimEnd();
}

function splitTomlLines(toml: string): string[] {
  const normalized = toml.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return [];
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

  const inner = trimmed.slice(1, -1);
  const out: string[] = [];

  let i = 0;
  const len = inner.length;
  const skipWhitespaceAndCommas = (): void => {
    while (i < len) {
      const ch = inner[i] ?? "";
      if (ch === "," || ch === " " || ch === "\t" || ch === "\r" || ch === "\n") i += 1;
      else break;
    }
  };

  const readQuoted = (quote: '"' | "'"): string | undefined => {
    const startQuote = inner[i];
    if (startQuote !== quote) return undefined;
    i += 1;

    let buf = "";
    let escapeNext = false;

    while (i < len) {
      const ch = inner[i] ?? "";
      i += 1;

      if (quote === '"') {
        if (escapeNext) {
          buf += ch;
          escapeNext = false;
          continue;
        }
        if (ch === "\\") {
          escapeNext = true;
          continue;
        }
        if (ch === '"') return buf;
        buf += ch;
        continue;
      }

      // quote === "'": literal string, no escapes
      if (ch === "'") return buf;
      buf += ch;
    }

    return undefined;
  };

  skipWhitespaceAndCommas();
  while (i < len) {
    const ch = inner[i] ?? "";
    if (ch === '"') {
      const value = readQuoted('"');
      if (value === undefined) return undefined;
      out.push(value);
      skipWhitespaceAndCommas();
      continue;
    }
    if (ch === "'") {
      const value = readQuoted("'");
      if (value === undefined) return undefined;
      out.push(value);
      skipWhitespaceAndCommas();
      continue;
    }

    // Only string arrays are supported for notify edits.
    return undefined;
  }

  return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function findFirstTableHeaderIndex(lines: string[]): number | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmedStart = raw.trimStart();
    if (trimmedStart.startsWith("#")) continue;

    const noComment = stripInlineTomlComment(raw).trim();
    if (noComment.startsWith("[") && noComment.endsWith("]")) return i;
  }
  return undefined;
}

type NotifyLineMatch = {
  index: number;
  rawLine: string;
  rhs: string;
  parsed?: string[];
  supported: boolean;
};

function findNotifyLines(lines: string[]): NotifyLineMatch[] {
  const matches: NotifyLineMatch[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const trimmedStart = rawLine.trimStart();
    if (trimmedStart.startsWith("#")) continue;

    const noComment = stripInlineTomlComment(rawLine);
    const match = noComment.match(/^\s*notify\s*=\s*(.+?)\s*$/);
    if (!match) continue;

    const rhs = match[1] ?? "";
    const supported = rhs.includes("[") && rhs.includes("]");
    const parsed = supported ? parseTomlStringArray(rhs) : undefined;
    matches.push({ index: i, rawLine, rhs, supported, ...(parsed ? { parsed } : {}) });
  }

  return matches;
}

function buildNotifyLine(command: readonly string[]): string {
  const escaped = command.map((v) => JSON.stringify(v)).join(", ");
  return `notify = [${escaped}]`;
}

export function editCodexConfigTomlInstallNotify(params: {
  toml: string;
  command?: readonly string[];
  force?: boolean;
}): NotifyEditResult {
  const command = params.command ?? EVS_CODEX_NOTIFY_COMMAND;
  const lines = splitTomlLines(params.toml);
  const notifyMatches = findNotifyLines(lines);

  if (notifyMatches.length > 0) {
    const match = notifyMatches[0]!;
    if (!match.supported || !match.parsed) {
      throw new Error("Unsupported existing notify config (expected a single-line string array).");
    }

    if (arraysEqual(match.parsed, command)) return { kind: "noop", reason: "already_installed" };

    if (!params.force) {
      throw new Error(
        `Codex notify is already configured (${JSON.stringify(match.parsed)}). Refusing to overwrite (use --force).`,
      );
    }

    const replaced = [...lines];
    replaced[match.index] = buildNotifyLine(command);
    const content = replaced.join("\n").replace(/\n*$/, "\n");
    return { kind: "changed", content };
  }

  const insertionIndex = findFirstTableHeaderIndex(lines) ?? lines.length;
  const next = [...lines];
  const notifyLine = buildNotifyLine(command);

  // If we insert before a table header, keep a blank line between root keys and the first table.
  const wantsBlankAfter = insertionIndex < lines.length && notifyLine.trim().length > 0;
  next.splice(insertionIndex, 0, notifyLine, ...(wantsBlankAfter ? [""] : []));

  const content = next.join("\n").replace(/\n*$/, "\n");
  return { kind: "changed", content };
}

export function editCodexConfigTomlUninstallNotify(params: {
  toml: string;
  command?: readonly string[];
}): NotifyEditResult {
  const command = params.command ?? EVS_CODEX_NOTIFY_COMMAND;
  const lines = splitTomlLines(params.toml);
  const matches = findNotifyLines(lines);
  if (matches.length === 0) return { kind: "noop", reason: "not_installed" };

  const removeIndexes = new Set<number>();
  for (const match of matches) {
    if (!match.supported || !match.parsed) continue;
    if (arraysEqual(match.parsed, command)) removeIndexes.add(match.index);
  }

  if (removeIndexes.size === 0) return { kind: "noop", reason: "not_installed" };

  const next = lines.filter((_, idx) => !removeIndexes.has(idx));

  // If we removed a root key right before a table header, avoid leaving two blank lines.
  for (let i = 0; i + 1 < next.length; ) {
    const cur = next[i] ?? "";
    const nxt = next[i + 1] ?? "";
    if (cur.trim().length === 0 && nxt.trim().length === 0) next.splice(i, 1);
    else i += 1;
  }

  const content = next.join("\n").replace(/\n*$/, "\n");
  return { kind: "changed", content };
}

export async function installCodexNotify(params: {
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; configPath: string }> {
  const env = params.env ?? process.env;
  const configPath = resolveCodexConfigPath(env);
  const exists = await fileExists(configPath);
  const current = exists ? await fs.readFile(configPath, "utf8") : "";

  const edited = editCodexConfigTomlInstallNotify({ toml: current, force: params.force === true });
  if (edited.kind === "noop") return { changed: false, configPath };

  if (exists) await createBackup(configPath);
  await writeFileAtomic(configPath, edited.content);
  return { changed: true, configPath };
}

export async function uninstallCodexNotify(params: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; configPath: string }> {
  const env = params.env ?? process.env;
  const configPath = resolveCodexConfigPath(env);
  const exists = await fileExists(configPath);
  if (!exists) return { changed: false, configPath };

  const current = await fs.readFile(configPath, "utf8");
  const edited = editCodexConfigTomlUninstallNotify({ toml: current });
  if (edited.kind === "noop") return { changed: false, configPath };

  await createBackup(configPath);
  await writeFileAtomic(configPath, edited.content);
  return { changed: true, configPath };
}
