import * as fs from "node:fs/promises";

import type { Command } from "commander";

import { fileExists } from "../core/fs.js";
import {
  defaultEvsConfig,
  evsGlobalConfigPath,
  type EvsConfig,
  parseEvsConfigStrict,
  resolveEvsConfigForCwd,
  writeEvsConfig,
} from "../core/project-config.js";
import { asString, isJsonObject } from "../core/json.js";
import { resolveClaudeSettingsPath, loadClaudeSettings, saveClaudeSettings } from "../integrations/claude/settings.js";
import { isEvsStatuslineCommand } from "../integrations/claude/statusline.js";
import {
  EVS_CODEX_NOTIFY_COMMAND,
  editCodexConfigTomlInstallNotify,
  resolveCodexConfigPath,
} from "../integrations/codex/config.js";

type Agent = "claude" | "codex";

type HookConfig = {
  type: "command";
  command: string;
  timeout?: number;
};

type HookMatcher = {
  matcher?: string;
  hooks: HookConfig[];
};

type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, HookMatcher[]>;
};

type InstallFlags = {
  agent: string;
  global?: boolean;
  hooks?: boolean;
  statusline?: boolean;
  notify?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

type HookDefinition = {
  name: string;
  event: string;
  baseCommand: string;
  timeout: number;
  usesMatcher: boolean;
};

type ExitCodeError = Error & { exitCode: number };

function isExitCodeError(error: unknown): error is ExitCodeError {
  return (
    error instanceof Error &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
  );
}

function errorWithExitCode(message: string, exitCode: number): ExitCodeError {
  return Object.assign(new Error(message), { exitCode });
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const out: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isRecord(existing) && isRecord(value)) out[key] = deepMerge(existing, value);
    else out[key] = value;
  }
  return out;
}

async function readEvsConfigFileStrict(configPath: string): Promise<EvsConfig | undefined> {
  if (!(await fileExists(configPath))) return undefined;
  const text = await fs.readFile(configPath, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw errorWithExitCode(`Invalid JSON in EVS config: ${configPath}`, 2);
  }

  const strict = parseEvsConfigStrict(obj);
  if (!strict.ok) {
    const bulletList = strict.errors.map((e) => `- ${e}`).join("\n");
    throw errorWithExitCode(`Invalid EVS config: ${configPath}\n${bulletList}`, 2);
  }
  return strict.config;
}

const CLAUDE_HOOKS: HookDefinition[] = [
  {
    name: "session-start",
    event: "SessionStart",
    baseCommand: "evs session-start",
    timeout: 2,
    usesMatcher: true,
  },
  {
    name: "auto-compact-stop",
    event: "Stop",
    baseCommand: "evs auto-compact start",
    timeout: 90,
    usesMatcher: false,
  },
];

function commandPrefix(baseCommand: string): string {
  const trimmed = baseCommand.trim();
  if (trimmed.length === 0) return trimmed;
  const parts = trimmed.split(/\s+/g);
  if (parts.length >= 2 && (parts[0] === "evs" || parts[0] === "eversession")) return `${parts[0]} ${parts[1]}`;
  return parts[0] ?? trimmed;
}

function inspectExistingEventHooks(params: { settings: ClaudeSettings; event: string; baseCommand: string }): {
  hasExact: boolean;
  hasOtherSamePrefix: boolean;
  prefix: string;
} {
  const prefix = commandPrefix(params.baseCommand);
  const eventHooks = params.settings.hooks?.[params.event] ?? [];
  let hasExact = false;
  let hasOtherSamePrefix = false;

  for (const matcher of eventHooks) {
    for (const hook of matcher.hooks) {
      const cmd = hook.command.trim();
      if (cmd === params.baseCommand) hasExact = true;
      if (cmd !== params.baseCommand && cmd.startsWith(prefix)) hasOtherSamePrefix = true;
    }
  }

  return { hasExact, hasOtherSamePrefix, prefix };
}

function installClaudeHook(settings: ClaudeSettings, def: HookDefinition): { changed: boolean; note: string } {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[def.event]) settings.hooks[def.event] = [];

  const eventHooks = settings.hooks[def.event]!;
  const existing = inspectExistingEventHooks({ settings, event: def.event, baseCommand: def.baseCommand });

  const newHook: HookConfig = { type: "command", command: def.baseCommand, timeout: def.timeout };

  // If the user already has a custom command for the same EVS subcommand (same prefix),
  // do not install our default. Clean up our exact default command if it exists.
  if (existing.hasOtherSamePrefix) {
    let changed = false;
    for (const matcher of eventHooks) {
      const beforeLen = matcher.hooks.length;
      matcher.hooks = matcher.hooks.filter((h) => h.command.trim() !== def.baseCommand);
      if (matcher.hooks.length !== beforeLen) changed = true;
    }
    settings.hooks[def.event] = eventHooks.filter((m) => m.hooks.length > 0);
    return { changed, note: `Skipped (custom ${existing.prefix} already configured)` };
  }

  // If the exact command is already present, preserve the user's timeout/placement and only dedupe.
  let hadAny = false;
  let keptOne = false;
  let changed = false;
  for (const matcher of eventHooks) {
    const beforeLen = matcher.hooks.length;
    matcher.hooks = matcher.hooks.filter((h) => {
      const cmd = h.command.trim();
      if (cmd !== def.baseCommand) return true;
      hadAny = true;
      if (keptOne) return false;
      keptOne = true;
      return true;
    });
    if (matcher.hooks.length !== beforeLen) changed = true;
  }
  settings.hooks[def.event] = eventHooks.filter((m) => m.hooks.length > 0);
  if (hadAny) return { changed, note: changed ? "Deduped" : "Already installed" };

  // Add our hook back in the correct shape for the event.
  const cleaned = settings.hooks[def.event] ?? [];
  if (def.usesMatcher) {
    const matchAll = cleaned.find((m) => (m.matcher ?? "") === "*");
    if (matchAll) matchAll.hooks.push(newHook);
    else cleaned.push({ matcher: "*", hooks: [newHook] });
  } else {
    cleaned.push({ hooks: [newHook] });
  }
  settings.hooks[def.event] = cleaned;

  return { changed: true, note: "Installed" };
}

function uninstallClaudeHook(settings: ClaudeSettings, def: HookDefinition): boolean {
  if (!settings.hooks) return false;
  const eventHooks = settings.hooks[def.event];
  if (!eventHooks) return false;

  let changed = false;
  for (const matcher of eventHooks) {
    const beforeLen = matcher.hooks.length;
    matcher.hooks = matcher.hooks.filter((h) => h.command.trim() !== def.baseCommand);
    if (matcher.hooks.length !== beforeLen) changed = true;
  }
  settings.hooks[def.event] = eventHooks.filter((m) => m.hooks.length > 0);
  if (settings.hooks[def.event]!.length === 0) delete settings.hooks[def.event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

async function ensureGlobalEvsConfigFile(params: { dryRun: boolean }): Promise<{ kind: "noop" | "created" | "updated"; path: string }> {
  const configPath = evsGlobalConfigPath();
  const exists = await fileExists(configPath);

  const existing = await readEvsConfigFileStrict(configPath);
  const next = (deepMerge(defaultEvsConfig(), existing ?? {}) as EvsConfig) satisfies EvsConfig;
  const nextText = JSON.stringify(next, null, 2) + "\n";
  const currentText = exists ? await fs.readFile(configPath, "utf8") : undefined;

  if (currentText === nextText) return { kind: "noop", path: configPath };
  if (params.dryRun) return { kind: exists ? "updated" : "created", path: configPath };

  await writeEvsConfig({ configPath, config: next });
  return { kind: exists ? "updated" : "created", path: configPath };
}

async function ensureLocalEvsConfigFile(params: { dryRun: boolean; cwd: string }): Promise<{ kind: "noop" | "created" | "updated"; path: string }> {
  const resolved = await resolveEvsConfigForCwd(params.cwd);
  const configPath = resolved.files.local.path;
  const exists = await fileExists(configPath);

  const next = resolved.config;
  const nextText = JSON.stringify(next, null, 2) + "\n";
  const currentText = exists ? await fs.readFile(configPath, "utf8") : undefined;

  if (currentText === nextText) return { kind: "noop", path: configPath };
  if (params.dryRun) return { kind: exists ? "updated" : "created", path: configPath };

  await writeEvsConfig({ configPath, config: next });
  return { kind: exists ? "updated" : "created", path: configPath };
}

async function installClaude(params: { global: boolean; dryRun: boolean; force: boolean; components: Set<string> }): Promise<void> {
  const settingsPath = resolveClaudeSettingsPath({ global: params.global, cwd: process.cwd() });
  const settings = (await loadClaudeSettings(settingsPath)) as ClaudeSettings;

  let changed = false;

  if (params.components.has("hooks")) {
    for (const def of CLAUDE_HOOKS) {
      const res = installClaudeHook(settings, def);
      if (res.changed) changed = true;
      process.stdout.write(`[evs install] Claude hooks: ${def.name}: ${res.note}\n`);
    }
  }

  if (params.components.has("statusline")) {
    const existing = settings.statusLine;
    const existingCommand = isJsonObject(existing) ? asString(existing.command) : asString(existing);
    if (existingCommand && isEvsStatuslineCommand(existingCommand)) {
      process.stdout.write("[evs install] Claude statusline: Already installed\n");
    } else if (existing !== undefined && !params.force) {
      process.stdout.write("[evs install] Claude statusline: Skipped (already configured; use --force)\n");
    } else {
      settings.statusLine = { type: "command", command: "evs statusline", padding: 0 };
      changed = true;
      process.stdout.write("[evs install] Claude statusline: Installed\n");
    }
  }

  if (!changed) return;
  if (params.dryRun) return;
  await saveClaudeSettings(settingsPath, settings);
  process.stdout.write(`[evs install] Wrote Claude settings: ${settingsPath}\n`);
}

async function installCodex(params: { dryRun: boolean; force: boolean; components: Set<string> }): Promise<void> {
  if (!params.components.has("notify")) return;

  const configPath = resolveCodexConfigPath();
  const exists = await fileExists(configPath);
  const current = exists ? await fs.readFile(configPath, "utf8") : "";

  const edited = editCodexConfigTomlInstallNotify({
    toml: current,
    command: EVS_CODEX_NOTIFY_COMMAND,
    force: params.force,
  });

  if (edited.kind === "noop") {
    process.stdout.write(`[evs install] Codex notify: Already installed (${configPath})\n`);
    return;
  }

  process.stdout.write(`[evs install] Codex notify: Installed (${configPath})\n`);
  if (params.dryRun) return;

  // `installCodexNotify()` takes a backup when editing an existing config; keep the same behavior here.
  if (exists) {
    const { createBackup } = await import("../core/fs.js");
    await createBackup(configPath);
  }
  const { writeFileAtomic } = await import("../core/fs.js");
  await writeFileAtomic(configPath, edited.content);
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("Install EVS integration for an agent")
    .requiredOption("--agent <agent>", "claude|codex")
    .option("-g, --global", "Claude: install into ~/.claude/settings.json (default: project-local)")
    .option("--hooks", "Claude: install hooks")
    .option("--statusline", "Claude: install status line")
    .option("--notify", "Codex: install notify hook")
    .option("--force", "overwrite existing agent config where safe")
    .option("--dry-run", "print what would change without writing")
    .action(async (opts: InstallFlags) => {
      const agentRaw = opts.agent.trim();
      const agent = agentRaw === "claude" || agentRaw === "codex" ? (agentRaw satisfies Agent) : undefined;
      if (!agent) {
        process.stderr.write("[evs install] Invalid --agent (expected claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const dryRun = opts.dryRun === true;
      const force = opts.force === true;

      const explicitComponents = new Set<string>();
      if (opts.hooks) explicitComponents.add("hooks");
      if (opts.statusline) explicitComponents.add("statusline");
      if (opts.notify) explicitComponents.add("notify");

      const components =
        explicitComponents.size > 0
          ? explicitComponents
          : agent === "claude"
            ? new Set<string>(["hooks", "statusline"])
            : new Set<string>(["notify"]);

      const allowed = agent === "claude" ? new Set<string>(["hooks", "statusline"]) : new Set<string>(["notify"]);
      const unsupported = [...components].filter((c) => !allowed.has(c));
      if (unsupported.length > 0) {
        process.stderr.write(`[evs install] Unsupported component(s) for ${agent}: ${unsupported.join(", ")}.\n`);
        process.exitCode = 2;
        return;
      }

      try {
        if (opts.global === true) {
          const cfg = await ensureGlobalEvsConfigFile({ dryRun });
          if (cfg.kind === "created") {
            process.stdout.write(`[evs install] EVS config: ${dryRun ? "Would create" : "Created"} ${cfg.path}\n`);
          } else if (cfg.kind === "updated") {
            process.stdout.write(`[evs install] EVS config: ${dryRun ? "Would update" : "Updated"} ${cfg.path}\n`);
          }
        } else {
          const localCfg = await ensureLocalEvsConfigFile({ dryRun, cwd: process.cwd() });
          if (localCfg.kind === "created") {
            process.stdout.write(
              `[evs install] EVS project config: ${dryRun ? "Would create" : "Created"} ${localCfg.path}\n`,
            );
          } else if (localCfg.kind === "updated") {
            process.stdout.write(
              `[evs install] EVS project config: ${dryRun ? "Would update" : "Updated"} ${localCfg.path}\n`,
            );
          }
        }

        if (agent === "claude") {
          await installClaude({
            global: opts.global === true,
            dryRun,
            force,
            components,
          });
        } else {
          await installCodex({ dryRun, force, components });
        }

        process.exitCode = 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        process.stderr.write(`[evs install] Error: ${msg}\n`);
        const isConfigError =
          typeof msg === "string" && (msg.startsWith("Invalid EVS config:") || msg.startsWith("Invalid JSON in EVS config:"));
        process.exitCode = isExitCodeError(error) ? error.exitCode : isConfigError ? 2 : 1;
      }
    });
}
