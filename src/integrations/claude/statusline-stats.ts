import * as fs from "node:fs/promises";

import { defaultStatuslineDumpPath } from "./statusline.js";

type Stats = {
  lines: number;
  parsed: number;
  spanSeconds?: number;
  deltasCount?: number;
  deltaMinSeconds?: number;
  deltaMedianSeconds?: number;
  deltaP95Seconds?: number;
  deltaMaxSeconds?: number;
  burstsLt1s?: number;
  firstTs?: string;
  lastTs?: string;
};

function defaultDumpPath(): string {
  return defaultStatuslineDumpPath();
}

function parseIso(ts: string): number | undefined {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return undefined;
  return ms;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return undefined;
  return (a + b) / 2;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function computeStats(filePath: string, tailLines: number): Promise<Stats> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return { lines: 0, parsed: 0 };
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tail = tailLines > 0 ? lines.slice(-tailLines) : lines;

  const tsMs: number[] = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line) as { ts?: unknown };
      const ts = typeof obj.ts === "string" ? obj.ts : undefined;
      const ms = ts ? parseIso(ts) : undefined;
      if (ms !== undefined) tsMs.push(ms);
    } catch {
      // ignore invalid lines
    }
  }

  const out: Stats = {
    lines: lines.length,
    parsed: tsMs.length,
  };

  if (tsMs.length < 2) {
    if (tsMs.length === 1) {
      const only = tsMs[0];
      if (only !== undefined) out.firstTs = new Date(only).toISOString();
      if (out.firstTs) out.lastTs = out.firstTs;
    }
    return out;
  }

  tsMs.sort((a, b) => a - b);
  const first = tsMs.at(0);
  const last = tsMs.at(-1);
  if (first === undefined || last === undefined) return out;

  out.firstTs = new Date(first).toISOString();
  out.lastTs = new Date(last).toISOString();
  out.spanSeconds = (last - first) / 1000;

  const deltas: number[] = [];
  for (let i = 1; i < tsMs.length; i++) {
    const cur = tsMs.at(i);
    const prev = tsMs.at(i - 1);
    if (cur === undefined || prev === undefined) continue;
    deltas.push((cur - prev) / 1000);
  }
  out.deltasCount = deltas.length;

  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const min = sortedDeltas.at(0);
  const max = sortedDeltas.at(-1);
  const med = median(sortedDeltas);
  const p95 = percentile(sortedDeltas, 0.95);
  if (min !== undefined) out.deltaMinSeconds = min;
  if (med !== undefined) out.deltaMedianSeconds = med;
  if (p95 !== undefined) out.deltaP95Seconds = p95;
  if (max !== undefined) out.deltaMaxSeconds = max;
  out.burstsLt1s = deltas.filter((d) => d < 1).length;

  return out;
}

export type StatuslineStatsOptions = {
  path?: string;
  tail: string;
  json?: boolean;
};

export async function runClaudeStatuslineStatsCommand(opts: StatuslineStatsOptions): Promise<void> {
  const filePath = opts.path ?? defaultDumpPath();
  const tail = Number(opts.tail);
  const tailLines = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 500;

  const stats = await computeStats(filePath, tailLines);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ file: filePath, ...stats }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`file=${filePath}\n`);
  process.stdout.write(`lines=${stats.lines} parsed=${stats.parsed}\n`);
  if (stats.firstTs) process.stdout.write(`first=${stats.firstTs}\n`);
  if (stats.lastTs) process.stdout.write(`last=${stats.lastTs}\n`);
  if (stats.spanSeconds !== undefined) process.stdout.write(`span=${stats.spanSeconds.toFixed(3)}s\n`);
  if (stats.deltasCount !== undefined) process.stdout.write(`deltas=${stats.deltasCount}\n`);
  if (stats.deltaMinSeconds !== undefined) {
    process.stdout.write(
      `delta_sec: min=${stats.deltaMinSeconds.toFixed(3)} median=${(stats.deltaMedianSeconds ?? 0).toFixed(3)} p95=${(stats.deltaP95Seconds ?? 0).toFixed(3)} max=${stats.deltaMaxSeconds!.toFixed(3)}\n`,
    );
  }
  if (stats.burstsLt1s !== undefined) process.stdout.write(`bursts_lt_1s=${stats.burstsLt1s}\n`);
}
