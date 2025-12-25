export function parseTokenThreshold(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error("[Core] Token threshold is empty.");

  const m = trimmed.match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!m) throw new Error(`[Core] Invalid token threshold: ${input} (expected e.g. 140000 or 140k)`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`[Core] Invalid token threshold: ${input}`);
  const multiplier = m[2] ? 1000 : 1;
  return Math.floor(value * multiplier);
}
