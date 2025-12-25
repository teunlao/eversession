import { runClaudeReloadCommand } from "./claude/reload.js";
import { readClaudeSupervisorEnv } from "./claude/supervisor-control.js";
import { runCodexReloadCommand } from "./codex/reload.js";
import { resolveCodexStatePath, resolveCodexThreadIdForCwd } from "./codex/state.js";
import { readCodexSupervisorEnv } from "./codex/supervisor-control.js";

type AgentChoice = "auto" | "claude" | "codex";

export async function runReloadCommand(params: { agent: AgentChoice; sessionIdArg?: string }): Promise<void> {
  if (params.agent === "claude") {
    await runClaudeReloadCommand(params.sessionIdArg);
    return;
  }
  if (params.agent === "codex") {
    await runCodexReloadCommand(params.sessionIdArg);
    return;
  }

  // Auto: prefer execution context (supervised).
  if (readClaudeSupervisorEnv()) {
    await runClaudeReloadCommand(params.sessionIdArg);
    return;
  }
  if (readCodexSupervisorEnv()) {
    await runCodexReloadCommand(params.sessionIdArg);
    return;
  }

  // Auto fallback: if we have a known Codex thread for this cwd, treat as Codex; otherwise Claude.
  try {
    const statePath = resolveCodexStatePath();
    const threadId = await resolveCodexThreadIdForCwd({ cwd: process.cwd(), statePath });
    if (threadId) {
      await runCodexReloadCommand(params.sessionIdArg);
      return;
    }
  } catch {
    // ignore
  }

  await runClaudeReloadCommand(params.sessionIdArg);
}

