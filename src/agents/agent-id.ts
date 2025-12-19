export const AGENT_IDS = ["claude", "codex"] as const;

export type AgentId = (typeof AGENT_IDS)[number];
