export { isUuid } from "../integrations/claude/context.js";
export type { ResolvedSessionPath, ResolveSessionPathResult } from "../integrations/claude/session-ref.js";
export {
  isPathLike,
  looksLikeSessionRef,
  resolveClaudeSessionRefForCli as resolveSessionPathForCli,
} from "../integrations/claude/session-ref.js";
