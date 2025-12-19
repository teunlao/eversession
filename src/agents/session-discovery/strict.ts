import type { SessionAlternative, SessionDiscoveryReport } from "./types.js";

export function isStrictFallbackAllowed(params: {
  top: { ageMs: number; score: number };
  runnerUp?: { ageMs: number; score: number };
}): boolean {
  if (!params.runnerUp) return true;

  // Consider it safe if either:
  // - runner-up is significantly older, OR
  // - runner-up has a significantly lower score.
  //
  // This matches the desired behavior:
  // - 5 minutes vs 1 week -> OK
  // - 5 minutes vs 30 minutes -> ambiguous
  const minAgeGapMs = 6 * 60 * 60 * 1000;
  const ageGapOk = params.runnerUp.ageMs - params.top.ageMs >= minAgeGapMs;
  const scoreGapOk = params.top.score - params.runnerUp.score >= 30;
  return ageGapOk || scoreGapOk;
}

export function pickRunnerUp(report: SessionDiscoveryReport): SessionAlternative | undefined {
  if (report.agent === "unknown") return undefined;
  for (const alt of report.alternatives) {
    if (alt.path !== report.session.path) return alt;
  }
  return undefined;
}
