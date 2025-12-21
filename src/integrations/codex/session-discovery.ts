import { type DiscoverCodexOptions, discoverCodexSession } from "../../agents/codex/discover.js";
import type { SessionDiscoveryReport } from "../../agents/session-discovery/types.js";
import { resolveCodexStatePath, resolveCodexThreadIdForCwd } from "./state.js";

export type CodexDiscoveryOptions = DiscoverCodexOptions;

export async function discoverCodexSessionReport(opts: CodexDiscoveryOptions): Promise<SessionDiscoveryReport> {
  if (!opts.sessionId && !opts.match) {
    const statePath = resolveCodexStatePath();
    try {
      const threadId = await resolveCodexThreadIdForCwd({ cwd: opts.cwd, statePath });
      if (threadId) {
        const fromState = await discoverCodexSession({ ...opts, sessionId: threadId });
        if (fromState.agent !== "unknown") return fromState;
      }
    } catch {
      // Ignore state file issues: discovery fallback still works.
    }
  }

  return discoverCodexSession(opts);
}
