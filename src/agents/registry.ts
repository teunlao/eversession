import type { AgentAdapter } from "./adapter.js";
import type { AgentId } from "./agent-id.js";
import type { DetectResult } from "./types.js";
import { claudeAdapter } from "./claude/adapter.js";
import { codexAdapter } from "./codex/adapter.js";

export type ClaudeAdapter = typeof claudeAdapter;
export type CodexAdapter = typeof codexAdapter;
export type AnyAgentAdapter = ClaudeAdapter | CodexAdapter;

const adapters = [claudeAdapter, codexAdapter] as const;

export function listAgentAdapters(): AnyAgentAdapter[] {
  return [...adapters];
}

export function getAgentAdapter(id: AgentId): AnyAgentAdapter {
  for (const adapter of adapters) {
    if (adapter.id === id) return adapter;
  }
  return claudeAdapter;
}

export function getAdapterForDetect(detected: DetectResult): AnyAgentAdapter | undefined {
  if (detected.agent === "unknown") return undefined;
  return getAgentAdapter(detected.agent);
}

export type { AgentAdapter };
