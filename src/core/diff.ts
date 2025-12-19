export type DiffLine = { line: number; text: string };

export type DiffOp =
  | { kind: "equal"; aLine: number; bLine: number; text: string }
  | { kind: "delete"; aLine: number; text: string }
  | { kind: "insert"; bLine: number; text: string };

type Anchor = { aIdx: number; bIdx: number };

function longestIncreasingSubsequence(indices: number[]): number[] {
  const n = indices.length;
  if (n === 0) return [];

  const predecessors = new Array<number>(n).fill(-1);
  const tails: number[] = [];

  const lowerBound = (value: number): number => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const idx = tails[mid];
      if (idx === undefined) return lo;
      const current = indices[idx];
      if (current !== undefined && current < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (let i = 0; i < n; i += 1) {
    const v = indices[i];
    if (v === undefined) continue;
    const pos = lowerBound(v);
    if (pos > 0) predecessors[i] = tails[pos - 1] ?? -1;
    if (pos === tails.length) tails.push(i);
    else tails[pos] = i;
  }

  const result: number[] = [];
  let k = tails[tails.length - 1] ?? -1;
  while (k !== -1) {
    result.push(k);
    k = predecessors[k] ?? -1;
  }
  result.reverse();
  return result;
}

function findAnchors(a: DiffLine[], a0: number, a1: number, b: DiffLine[], b0: number, b1: number): Anchor[] {
  const aCount = new Map<string, { count: number; idx: number }>();
  for (let i = a0; i < a1; i += 1) {
    const line = a[i];
    if (!line) continue;
    const entry = aCount.get(line.text);
    if (entry) entry.count += 1;
    else aCount.set(line.text, { count: 1, idx: i });
  }

  const bCount = new Map<string, { count: number; idx: number }>();
  for (let i = b0; i < b1; i += 1) {
    const line = b[i];
    if (!line) continue;
    const entry = bCount.get(line.text);
    if (entry) entry.count += 1;
    else bCount.set(line.text, { count: 1, idx: i });
  }

  const candidates: Anchor[] = [];
  for (const [text, aEntry] of aCount.entries()) {
    if (aEntry.count !== 1) continue;
    const bEntry = bCount.get(text);
    if (!bEntry || bEntry.count !== 1) continue;
    candidates.push({ aIdx: aEntry.idx, bIdx: bEntry.idx });
  }

  candidates.sort((x, y) => x.aIdx - y.aIdx);
  const bIndices = candidates.map((c) => c.bIdx);
  const lis = longestIncreasingSubsequence(bIndices);
  return lis.map((i) => candidates[i]!).filter(Boolean);
}

function fallbackDiff(ops: DiffOp[], a: DiffLine[], a0: number, a1: number, b: DiffLine[], b0: number, b1: number): void {
  let prefix = 0;
  while (a0 + prefix < a1 && b0 + prefix < b1) {
    const left = a[a0 + prefix];
    const right = b[b0 + prefix];
    if (!left || !right || left.text !== right.text) break;
    ops.push({ kind: "equal", aLine: left.line, bLine: right.line, text: left.text });
    prefix += 1;
  }

  let suffix = 0;
  while (a1 - suffix - 1 >= a0 + prefix && b1 - suffix - 1 >= b0 + prefix) {
    const left = a[a1 - suffix - 1];
    const right = b[b1 - suffix - 1];
    if (!left || !right || left.text !== right.text) break;
    suffix += 1;
  }

  for (let i = a0 + prefix; i < a1 - suffix; i += 1) {
    const left = a[i];
    if (left) ops.push({ kind: "delete", aLine: left.line, text: left.text });
  }
  for (let i = b0 + prefix; i < b1 - suffix; i += 1) {
    const right = b[i];
    if (right) ops.push({ kind: "insert", bLine: right.line, text: right.text });
  }

  for (let i = suffix; i > 0; i -= 1) {
    const left = a[a1 - i];
    const right = b[b1 - i];
    if (left && right) ops.push({ kind: "equal", aLine: left.line, bLine: right.line, text: left.text });
  }
}

export function patienceDiff(a: DiffLine[], b: DiffLine[]): DiffOp[] {
  const ops: DiffOp[] = [];

  const diffRange = (a0: number, a1: number, b0: number, b1: number): void => {
    if (a0 >= a1) {
      for (let i = b0; i < b1; i += 1) {
        const line = b[i];
        if (line) ops.push({ kind: "insert", bLine: line.line, text: line.text });
      }
      return;
    }
    if (b0 >= b1) {
      for (let i = a0; i < a1; i += 1) {
        const line = a[i];
        if (line) ops.push({ kind: "delete", aLine: line.line, text: line.text });
      }
      return;
    }

    const anchors = findAnchors(a, a0, a1, b, b0, b1);
    if (anchors.length === 0) {
      fallbackDiff(ops, a, a0, a1, b, b0, b1);
      return;
    }

    let prevA = a0;
    let prevB = b0;
    for (const anchor of anchors) {
      diffRange(prevA, anchor.aIdx, prevB, anchor.bIdx);

      const left = a[anchor.aIdx];
      const right = b[anchor.bIdx];
      if (left && right) {
        ops.push({ kind: "equal", aLine: left.line, bLine: right.line, text: left.text });
      }

      prevA = anchor.aIdx + 1;
      prevB = anchor.bIdx + 1;
    }
    diffRange(prevA, a1, prevB, b1);
  };

  diffRange(0, a.length, 0, b.length);
  return ops;
}

export function summarizeDiff(ops: DiffOp[]): { equal: number; insert: number; delete: number } {
  const out = { equal: 0, insert: 0, delete: 0 };
  for (const op of ops) {
    if (op.kind === "equal") out.equal += 1;
    else if (op.kind === "insert") out.insert += 1;
    else out.delete += 1;
  }
  return out;
}
