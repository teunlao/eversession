import type { Issue } from "../../core/issues.js";
import type { AgentId } from "../agent-id.js";

export type SessionDiscoveryMethod = "session-id" | "match" | "cwd-hash" | "fallback" | "hook" | "env";
export type SessionConfidence = "high" | "medium" | "low";

export type SessionHealth = { parseErrors: number; validationErrors: number; validationWarnings: number };

export type SessionAlternative = { path: string; score: number; reason: string };

export type SessionHit = {
  path: string;
  agent: AgentId;
  method: SessionDiscoveryMethod;
  confidence: SessionConfidence;
  score?: number;
  id?: string;
  cwd?: string;
  projectHash?: string;
  mtime?: string;
  lastActivity?: string;
  health?: SessionHealth;
  sidechains?: string[];
};

export type SessionDiscoveryReport =
  | {
    agent: AgentId;
    cwd: string;
    method: SessionDiscoveryMethod;
    confidence: SessionConfidence;
    session: SessionHit;
    alternatives: SessionAlternative[];
  }
  | {
    agent: "unknown";
    cwd: string;
    issues: Issue[];
    alternatives: SessionAlternative[];
  };
