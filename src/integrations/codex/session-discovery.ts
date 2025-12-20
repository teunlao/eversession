import { type DiscoverCodexOptions, discoverCodexSession } from "../../agents/codex/discover.js";
import type { SessionDiscoveryReport } from "../../agents/session-discovery/types.js";

export type CodexDiscoveryOptions = DiscoverCodexOptions;

export async function discoverCodexSessionReport(opts: CodexDiscoveryOptions): Promise<SessionDiscoveryReport> {
  return discoverCodexSession(opts);
}
