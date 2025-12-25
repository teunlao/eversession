import type { Issue } from "../core/issues.js";
import type { AgentId } from "./agent-id.js";

export type { AgentId };

export type DetectResult =
  | {
      agent: AgentId;
      format: string;
      confidence: "high" | "medium" | "low";
      notes?: string[];
    }
  | {
      agent: "unknown";
      confidence: "low";
      notes: string[];
    };

export type ValidateResult = {
  issues: Issue[];
};
