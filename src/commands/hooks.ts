import { Command } from "commander";

import { isEvsCliCommandPrefix } from "../core/brand.js";
import { loadClaudeSettings, resolveClaudeSettingsPath, saveClaudeSettings } from "../integrations/claude/settings.js";

interface HookConfig {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookConfig[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

interface HookDefinition {
  event: string;
  description: string;
  baseCommand: string;
  timeout: number;
  usesMatcher: boolean;
}

const AVAILABLE_HOOKS: Record<string, HookDefinition> = {
  "session-info": {
    event: "SessionStart",
    description: "Show session info on start",
    baseCommand: "evs info",
    timeout: 5,
    usesMatcher: true,
  },
  "session-env": {
    event: "SessionStart",
    description: "Export transcript_path into CLAUDE_ENV_FILE (for !evs open in bash mode)",
    baseCommand: "evs hook-env",
    timeout: 2,
    usesMatcher: true,
  },
  "session-start-log": {
    event: "SessionStart",
    description: "Log session start/resume (for statusline reload detection)",
    baseCommand: "evs session-start",
    timeout: 2,
    usesMatcher: true,
  },
  "session-stop": {
    event: "Stop",
    description: "Show session info on stop",
    baseCommand: "evs info",
    timeout: 5,
    usesMatcher: false,
  },
  "auto-compact-stop": {
    event: "Stop",
    description: "Auto-compact session on Stop (token threshold trigger)",
    baseCommand: "evs auto-compact start --threshold 140k --amount 25% --model haiku --busy-timeout 10s --notify",
    timeout: 90,
    usesMatcher: false,
  },
};

function commandPrefix(baseCommand: string): string {
  const trimmed = baseCommand.trim();
  if (trimmed.length === 0) return trimmed;
  const parts = trimmed.split(/\s+/g);
  if (parts.length >= 2 && isEvsCliCommandPrefix(parts[0] ?? "")) return `${parts[0]} ${parts[1]}`;
  return parts[0] ?? trimmed;
}

function inspectExistingEventHooks(params: {
  settings: ClaudeSettings;
  event: string;
  baseCommand: string;
}): { hasExact: boolean; hasOtherSamePrefix: boolean; prefix: string } {
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

function isHookInstalled(settings: ClaudeSettings, hookName: string): boolean {
  const hookDef = AVAILABLE_HOOKS[hookName];
  if (!hookDef) return false;

  const eventHooks = settings.hooks?.[hookDef.event];
  if (!eventHooks) return false;

  for (const matcher of eventHooks) {
    for (const hook of matcher.hooks) {
      if (hook.command.trim() === hookDef.baseCommand) return true;
    }
  }

  return false;
}

function installHook(settings: ClaudeSettings, hookName: string): ClaudeSettings {
  const hookDef = AVAILABLE_HOOKS[hookName];
  if (!hookDef) return settings;

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const hooks = settings.hooks;
  if (!hooks[hookDef.event]) {
    hooks[hookDef.event] = [];
  }

  const eventHooks = hooks[hookDef.event]!;
  const existing = inspectExistingEventHooks({ settings, event: hookDef.event, baseCommand: hookDef.baseCommand });

  const newHook: HookConfig = {
    type: "command",
    command: hookDef.baseCommand,
    timeout: hookDef.timeout,
  };

  const dedupeExactKeepFirst = (): { hadAny: boolean; changed: boolean } => {
    let hadAny = false;
    let keptOne = false;
    let changed = false;

    for (const matcher of eventHooks) {
      const beforeLen = matcher.hooks.length;
      matcher.hooks = matcher.hooks.filter((h) => {
        const cmd = h.command.trim();
        if (cmd !== hookDef.baseCommand) return true;
        hadAny = true;
        if (keptOne) return false;
        keptOne = true;
        return true;
      });
      if (matcher.hooks.length !== beforeLen) changed = true;
    }

    hooks[hookDef.event] = eventHooks.filter((m) => m.hooks.length > 0);
    if (hooks[hookDef.event]!.length !== eventHooks.length) changed = true;

    return { hadAny, changed };
  };

  // If the user already has a custom command for the same EVS subcommand (same prefix),
  // do not install our default. Clean up our exact default command if it exists.
  if (existing.hasOtherSamePrefix) {
    for (const matcher of eventHooks) {
      matcher.hooks = matcher.hooks.filter((h) => h.command.trim() !== hookDef.baseCommand);
    }
    hooks[hookDef.event] = eventHooks.filter((m) => m.hooks.length > 0);
    return settings;
  }

  // If the exact command is already present, preserve the user's timeout/placement and only dedupe.
  const deduped = dedupeExactKeepFirst();
  if (deduped.hadAny) return settings;

  // Add our hook back in the correct shape for the event.
  const cleaned = hooks[hookDef.event] ?? [];
  if (hookDef.usesMatcher) {
    const matchAll = cleaned.find((m) => (m.matcher ?? "") === "*");
    if (matchAll) matchAll.hooks.push(newHook);
    else cleaned.push({ matcher: "*", hooks: [newHook] });
  } else {
    // Events like Stop don't use matchers; omit it.
    cleaned.push({ hooks: [newHook] });
  }

  hooks[hookDef.event] = cleaned;

  return settings;
}

function uninstallHook(settings: ClaudeSettings, hookName: string): ClaudeSettings {
  const hookDef = AVAILABLE_HOOKS[hookName];
  if (!hookDef) return settings;

  if (!settings.hooks) {
    return settings;
  }

  const eventHooks = settings.hooks[hookDef.event];
  if (!eventHooks) {
    return settings;
  }

  for (const matcher of eventHooks) {
    matcher.hooks = matcher.hooks.filter((h) => h.command.trim() !== hookDef.baseCommand);
  }

  // Remove empty matchers
  settings.hooks[hookDef.event] = eventHooks.filter((m) => m.hooks.length > 0);

  // Remove empty events
  if (settings.hooks[hookDef.event]!.length === 0) {
    delete settings.hooks[hookDef.event];
  }

  return settings;
}

export function registerHooksCommand(program: Command): void {
  const hooksCmd = program.command("hooks").description("Manage Claude Code hooks");

  hooksCmd
    .command("install")
    .description("Install EverSession hooks")
    .option("-g, --global", "install into ~/.claude/settings.json instead of <project>/.claude/settings.json")
    .action(async (cmdOpts: { global?: boolean }) => {
      try {
        const settingsPath = resolveClaudeSettingsPath({ global: cmdOpts.global === true, cwd: process.cwd() });
        const settings = (await loadClaudeSettings(settingsPath)) as ClaudeSettings;
        let changed = 0;

        for (const [hookName, def] of Object.entries(AVAILABLE_HOOKS)) {
          const existing = inspectExistingEventHooks({ settings, event: def.event, baseCommand: def.baseCommand });
          const before = JSON.stringify(settings.hooks?.[def.event] ?? null);
          const updated = installHook(settings, hookName);
          Object.assign(settings, updated);
          const after = JSON.stringify(settings.hooks?.[def.event] ?? null);

          if (before !== after) {
            if (existing.hasOtherSamePrefix) {
              console.log(`✓ Kept custom ${existing.prefix} (removed default): ${hookName} (${def.event})`);
            } else {
              console.log(`✓ Installed: ${hookName} (${def.event})`);
            }
            changed++;
          } else {
            if (existing.hasOtherSamePrefix && !existing.hasExact) {
              console.log(`○ Skipped (custom ${existing.prefix} already configured): ${hookName}`);
            } else {
              console.log(`○ Already installed: ${hookName}`);
            }
          }
        }

        if (changed > 0) {
          await saveClaudeSettings(settingsPath, settings);
          console.log(`\n${changed} hook(s) installed.`);
          console.log("Restart Claude Code for changes to take effect.");
        } else {
          console.log("\nAll hooks already installed.");
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
        process.exitCode = 1;
      }
    });

  hooksCmd
    .command("uninstall")
    .description("Uninstall EverSession hooks")
    .option("-g, --global", "uninstall from ~/.claude/settings.json instead of <project>/.claude/settings.json")
    .action(async (cmdOpts: { global?: boolean }) => {
      try {
        const settingsPath = resolveClaudeSettingsPath({ global: cmdOpts.global === true, cwd: process.cwd() });
        let settings = (await loadClaudeSettings(settingsPath)) as ClaudeSettings;
        let uninstalled = 0;

        for (const hookName of Object.keys(AVAILABLE_HOOKS)) {
          if (isHookInstalled(settings, hookName)) {
            settings = uninstallHook(settings, hookName);
            console.log(`✓ Uninstalled: ${hookName}`);
            uninstalled++;
          }
        }

        if (uninstalled > 0) {
          await saveClaudeSettings(settingsPath, settings);
          console.log(`\n${uninstalled} hook(s) uninstalled.`);
          console.log("Restart Claude Code for changes to take effect.");
        } else {
          console.log("\nNo hooks to uninstall.");
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
        process.exitCode = 1;
      }
    });

  hooksCmd
    .command("status")
    .description("Show current hooks status")
    .option("-g, --global", "read ~/.claude/settings.json instead of <project>/.claude/settings.json")
    .action(async (cmdOpts: { global?: boolean }) => {
      try {
        const settingsPath = resolveClaudeSettingsPath({ global: cmdOpts.global === true, cwd: process.cwd() });
        const settings = (await loadClaudeSettings(settingsPath)) as ClaudeSettings;

        if (!settings.hooks || Object.keys(settings.hooks).length === 0) {
          console.log("No hooks configured in Claude settings.");
          return;
        }

        console.log("Current Claude hooks:\n");

        for (const [event, matchers] of Object.entries(settings.hooks)) {
          console.log(`${event}:`);
          for (const matcher of matchers) {
            if (matcher.matcher !== undefined) console.log(`  matcher: ${matcher.matcher}`);
            for (const hook of matcher.hooks) {
              const prefix = hook.command.trim().split(/\s+/g)[0] ?? "";
              const isEvs = isEvsCliCommandPrefix(prefix);
              const marker = isEvs ? "→" : " ";
              console.log(`    ${marker} ${hook.command} (timeout: ${hook.timeout ?? "default"})`);
            }
          }
          console.log("");
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
        process.exitCode = 1;
      }
    });
}
