export type CountOrPercent = { kind: "count"; count: number } | { kind: "percent"; percent: number };

export type TokensOrPercent = { kind: "tokens"; tokens: number } | { kind: "percent"; percent: number };

export function parseCountOrPercent(input: string): CountOrPercent {
  const trimmed = input.trim();
  if (trimmed.endsWith("%")) {
    const num = trimmed.slice(0, -1).trim();
    const value = Number(num);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`[Core] Invalid percent value: ${input}`);
    }
    return { kind: "percent", percent: value };
  }

  const count = Number(trimmed);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    throw new Error(`[Core] Invalid count value: ${input}`);
  }
  return { kind: "count", count };
}

export function parseTokensOrPercent(input: string): TokensOrPercent {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("[Core] Token amount is empty.");

  if (trimmed.endsWith("%")) {
    const num = trimmed.slice(0, -1).trim();
    const value = Number(num);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`[Core] Invalid token percent: ${input}`);
    }
    return { kind: "percent", percent: value };
  }

  const lower = trimmed.toLowerCase();
  const m = lower.match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!m) throw new Error(`[Core] Invalid token amount: ${input} (expected e.g. 30000, 30k, or 25%)`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`[Core] Invalid token amount: ${input}`);
  const multiplier = m[2] ? 1000 : 1;
  return { kind: "tokens", tokens: Math.floor(value * multiplier) };
}

export function parseLineSpec(spec: string): number[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new Error("[Core] Line spec is empty.");

  const out = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;

    const range = part.split("-");
    if (range.length === 1) {
      const value = Number(range[0]);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
        throw new Error(`[Core] Invalid line number: ${part}`);
      }
      out.add(value);
      continue;
    }

    if (range.length === 2) {
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (!Number.isFinite(start) || !Number.isInteger(start) || start < 1) {
        throw new Error(`[Core] Invalid line range start: ${part}`);
      }
      if (!Number.isFinite(end) || !Number.isInteger(end) || end < 1) {
        throw new Error(`[Core] Invalid line range end: ${part}`);
      }
      if (end < start) {
        throw new Error(`[Core] Invalid line range (end < start): ${part}`);
      }
      for (let n = start; n <= end; n += 1) out.add(n);
      continue;
    }

    throw new Error(`[Core] Invalid line range: ${part}`);
  }

  return [...out].sort((a, b) => a - b);
}
