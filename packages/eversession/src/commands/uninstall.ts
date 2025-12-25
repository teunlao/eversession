import * as fs from "node:fs/promises";

import type { Command } from "commander";

import { fileExists } from "../core/fs.js";
import { asString, isJsonObject } from "../core/json.js";
import { resolveClaudeSettingsPath, loadClaudeSettings, saveClaudeSettings } from "../integrations/claude/settings.js";
import { isEvsStatuslineCommand } from "../integrations/claude/statusline.js";
import {
  EVS_CODEX_NOTIFY_COMMAND,
  editCodexConfigTomlUninstallNotify,
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

type UninstallFlags = {
  agent?: string;
  global?: boolean;
  hooks?: boolean;
  statusline?: boolean;
  notify?: boolean;
  dryRun?: boolean;
};

type HookDefinition = {
  name: string;
  event: string;
  baseCommand: string;
};

const CLAUDE_HOOKS: HookDefinition[] = [
  { name: "session-start", event: "SessionStart", baseCommand: "evs session-start" },
  { name: "auto-compact-stop", event: "Stop", baseCommand: "evs auto-compact start" },
];

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

async function uninstallClaude(params: { global: boolean; dryRun: boolean; components: Set<string> }): Promise<void> {
  const settingsPath = resolveClaudeSettingsPath({ global: params.global, cwd: process.cwd() });
  const settings = (await loadClaudeSettings(settingsPath)) as ClaudeSettings;

  let changed = false;

  if (params.components.has("hooks")) {
    for (const def of CLAUDE_HOOKS) {
      const removed = uninstallClaudeHook(settings, def);
      process.stdout.write(`[evs uninstall] Claude hooks: ${def.name}: ${removed ? "Uninstalled" : "Not installed"}\n`);
      if (removed) changed = true;
    }
  }

  if (params.components.has("statusline")) {
    const existing = settings.statusLine;
    const existingCommand = isJsonObject(existing) ? asString(existing.command) : asString(existing);
    if (!existingCommand || !isEvsStatuslineCommand(existingCommand)) {
      process.stdout.write("[evs uninstall] Claude statusline: Not installed\n");
    } else {
      delete settings.statusLine;
      changed = true;
      process.stdout.write("[evs uninstall] Claude statusline: Uninstalled\n");
    }
  }

  if (!changed) return;
  if (params.dryRun) return;
  await saveClaudeSettings(settingsPath, settings);
  process.stdout.write(`[evs uninstall] Wrote Claude settings: ${settingsPath}\n`);
}

async function uninstallCodex(params: { dryRun: boolean; components: Set<string> }): Promise<void> {
  if (!params.components.has("notify")) return;

  const configPath = resolveCodexConfigPath();
  const exists = await fileExists(configPath);
  if (!exists) {
    process.stdout.write(`[evs uninstall] Codex notify: Not installed (${configPath})\n`);
    return;
  }

  const current = await fs.readFile(configPath, "utf8");
  const edited = editCodexConfigTomlUninstallNotify({ toml: current, command: EVS_CODEX_NOTIFY_COMMAND });

  if (edited.kind === "noop") {
    process.stdout.write(`[evs uninstall] Codex notify: Not installed (${configPath})\n`);
    return;
  }

  process.stdout.write(`[evs uninstall] Codex notify: Uninstalled (${configPath})\n`);
  if (params.dryRun) return;

  const { createBackup, writeFileAtomic } = await import("../core/fs.js");
  await createBackup(configPath);
  await writeFileAtomic(configPath, edited.content);
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("Uninstall EVS integration artifacts (does not delete ~/.evs/config.json)")
    .option("--agent <agent>", "claude|codex (default: all)")
    .option("-g, --global", "Claude: uninstall from ~/.claude/settings.json (default: project-local)")
    .option("--hooks", "Claude: uninstall hooks")
    .option("--statusline", "Claude: uninstall status line")
    .option("--notify", "Codex: uninstall notify hook")
    .option("--dry-run", "print what would change without writing")
    .action(async (opts: UninstallFlags) => {
      const agentRaw = opts.agent?.trim();
      const agent = agentRaw === undefined ? undefined : agentRaw === "claude" || agentRaw === "codex" ? (agentRaw satisfies Agent) : undefined;
      if (agentRaw !== undefined && !agent) {
        process.stderr.write("[evs uninstall] Invalid --agent (expected claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const dryRun = opts.dryRun === true;

      const explicitComponents = new Set<string>();
      if (opts.hooks) explicitComponents.add("hooks");
      if (opts.statusline) explicitComponents.add("statusline");
      if (opts.notify) explicitComponents.add("notify");

      const defaultClaude = new Set<string>(["hooks", "statusline"]);
      const defaultCodex = new Set<string>(["notify"]);

      const runClaude = agent === undefined || agent === "claude";
      const runCodex = agent === undefined || agent === "codex";

      if (agent !== undefined && explicitComponents.size > 0) {
        const allowed = agent === "claude" ? new Set<string>(["hooks", "statusline"]) : new Set<string>(["notify"]);
        const unsupported = [...explicitComponents].filter((c) => !allowed.has(c));
        if (unsupported.length > 0) {
          process.stderr.write(`[evs uninstall] Unsupported component(s) for ${agent}: ${unsupported.join(", ")}.\n`);
          process.exitCode = 2;
          return;
        }
      }

      try {
        if (runClaude) {
          const components = explicitComponents.size > 0 ? explicitComponents : defaultClaude;
          await uninstallClaude({ global: opts.global === true, dryRun, components });
        }
        if (runCodex) {
          const components = explicitComponents.size > 0 ? explicitComponents : defaultCodex;
          await uninstallCodex({ dryRun, components });
        }
        process.exitCode = 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        process.stderr.write(`[evs uninstall] Error: ${msg}\n`);
        process.exitCode = 1;
      }
    });
}
