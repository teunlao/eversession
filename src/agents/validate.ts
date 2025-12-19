import type { Issue } from "../core/issues.js";

export type Suggestion = { command: string; reason: string };

export type SuggestParams = { path: string; issues: Issue[] };
