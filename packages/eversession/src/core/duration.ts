export function parseDurationMs(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("[Core] Duration is empty.");

  const m = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  if (!m) throw new Error(`[Core] Invalid duration: ${input} (expected e.g. 250ms or 10s)`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`[Core] Invalid duration value: ${input}`);
  const unit = m[2];
  if (unit === "ms") return Math.floor(value);
  return Math.floor(value * 1000);
}
