import { diffJsonPatch, type JsonPatchOp, type JsonValue } from "../src/internals";
import { parsePositiveIntEnv } from "./utils";

type BenchmarkStats = {
  readonly name: string;
  readonly minMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly avgHeapDeltaMb: number;
};

function percentile(sortedValues: number[], p: number): number {
  const pos = Math.floor((sortedValues.length - 1) * p);
  return sortedValues[pos]!;
}

function format(n: number): string {
  return n.toFixed(2);
}

function measure(name: string, runs: number, fn: () => void): BenchmarkStats {
  const warmups = Math.min(3, runs);
  for (let i = 0; i < warmups; i++) {
    fn();
  }

  const samplesMs: number[] = [];
  const heapDeltasMb: number[] = [];

  for (let i = 0; i < runs; i++) {
    const beforeHeap = process.memoryUsage().heapUsed;
    const start = Bun.nanoseconds();
    fn();
    const end = Bun.nanoseconds();
    const afterHeap = process.memoryUsage().heapUsed;

    samplesMs.push((end - start) / 1_000_000);
    heapDeltasMb.push((afterHeap - beforeHeap) / 1024 / 1024);
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = samplesMs.reduce((acc, value) => acc + value, 0);
  const nonNegativeHeapDeltasMb = heapDeltasMb.filter((value) => value >= 0);
  const avgHeapDeltaMb =
    nonNegativeHeapDeltasMb.reduce((acc, value) => acc + value, 0) /
    Math.max(1, nonNegativeHeapDeltasMb.length);

  return {
    name,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    avgMs: total / samplesMs.length,
    p50Ms: percentile(sorted, 0.5),
    avgHeapDeltaMb,
  };
}

function buildWideObject(width: number): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};

  for (let i = 0; i < width; i++) {
    out[formatKey(i)] = i;
  }

  return out;
}

function buildNextWideObject(
  base: Record<string, JsonValue>,
  width: number,
): Record<string, JsonValue> {
  const next = { ...base };
  const removeIndexes = [1, Math.floor(width / 5), Math.floor(width / 2)];
  const replaceIndexes = [2, Math.floor(width / 3), Math.floor((width * 4) / 5)];
  const addIndexes = [width, width + 1, width + 2];

  for (const index of removeIndexes) {
    delete next[formatKey(index)];
  }

  for (const index of replaceIndexes) {
    next[formatKey(index)] = -index;
  }

  for (const index of addIndexes) {
    next[formatKey(index)] = index;
  }

  return next;
}

function buildNestedValue(index: number): JsonValue {
  return {
    meta: {
      id: index,
      label: `item-${index}`,
      tags: [`tag-${index % 7}`, `group-${index % 5}`],
    },
    payload: {
      active: index % 2 === 0,
      score: index * 10,
      trail: [index, index + 1, index + 2],
    },
  };
}

function buildWideNestedObject(width: number): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};

  for (let i = 0; i < width; i++) {
    out[formatKey(i)] = buildNestedValue(i);
  }

  return out;
}

function buildNextWideNestedRewriteObject(
  base: Record<string, JsonValue>,
  width: number,
): Record<string, JsonValue> {
  const renameIndexes = uniqueIndexes(width, [1, Math.floor(width / 5), Math.floor(width / 2)]);
  const duplicateIndexes = uniqueIndexes(width, [
    2,
    Math.floor(width / 4),
    Math.floor((width * 4) / 5),
  ]).filter((index) => !renameIndexes.includes(index));
  const next: Record<string, JsonValue> = {};

  for (let i = 0; i < width; i++) {
    const sourceKey = formatKey(i);
    const targetKey = renameIndexes.includes(i) ? formatRenamedKey(i) : sourceKey;
    next[targetKey] = base[sourceKey]!;
  }

  for (const index of duplicateIndexes) {
    next[formatDuplicateKey(index)] = base[formatKey(index)]!;
  }

  return next;
}

function formatKey(index: number): string {
  return `k${String(index).padStart(5, "0")}`;
}

function formatRenamedKey(index: number): string {
  return `renamed-${String(index).padStart(5, "0")}`;
}

function formatDuplicateKey(index: number): string {
  return `duplicate-${String(index).padStart(5, "0")}`;
}

function uniqueIndexes(width: number, indexes: readonly number[]): number[] {
  return [...new Set(indexes.filter((index) => index >= 0 && index < width))].sort((a, b) => a - b);
}

function legacyDiffJsonPatch(base: JsonValue, next: JsonValue): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  legacyDiffValue([], base, next, ops);
  return ops;
}

function legacyDiffValue(
  path: string[],
  base: JsonValue,
  next: JsonValue,
  ops: JsonPatchOp[],
): void {
  if (jsonEquals(base, next)) {
    return;
  }

  if (Array.isArray(base) || Array.isArray(next)) {
    ops.push({ op: "replace", path: stringifyJsonPointer(path), value: next });
    return;
  }

  if (!isPlainObject(base) || !isPlainObject(next)) {
    ops.push({ op: "replace", path: stringifyJsonPointer(path), value: next });
    return;
  }

  const baseKeys = Object.keys(base).sort();
  const nextKeys = Object.keys(next).sort();

  let baseIndex = 0;
  let nextIndex = 0;

  while (baseIndex < baseKeys.length && nextIndex < nextKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const nextKey = nextKeys[nextIndex]!;

    if (baseKey === nextKey) {
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (baseKey < nextKey) {
      path.push(baseKey);
      ops.push({ op: "remove", path: stringifyJsonPointer(path) });
      path.pop();
      baseIndex += 1;
      continue;
    }

    nextIndex += 1;
  }

  while (baseIndex < baseKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    path.push(baseKey);
    ops.push({ op: "remove", path: stringifyJsonPointer(path) });
    path.pop();
    baseIndex += 1;
  }

  baseIndex = 0;
  nextIndex = 0;
  while (baseIndex < baseKeys.length && nextIndex < nextKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const nextKey = nextKeys[nextIndex]!;

    if (baseKey === nextKey) {
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (baseKey < nextKey) {
      baseIndex += 1;
      continue;
    }

    path.push(nextKey);
    ops.push({
      op: "add",
      path: stringifyJsonPointer(path),
      value: next[nextKey]!,
    });
    path.pop();
    nextIndex += 1;
  }

  while (nextIndex < nextKeys.length) {
    const nextKey = nextKeys[nextIndex]!;
    path.push(nextKey);
    ops.push({
      op: "add",
      path: stringifyJsonPointer(path),
      value: next[nextKey]!,
    });
    path.pop();
    nextIndex += 1;
  }

  baseIndex = 0;
  nextIndex = 0;
  while (baseIndex < baseKeys.length && nextIndex < nextKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const nextKey = nextKeys[nextIndex]!;

    if (baseKey === nextKey) {
      path.push(baseKey);
      legacyDiffValue(path, base[baseKey]!, next[nextKey]!, ops);
      path.pop();
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (baseKey < nextKey) {
      baseIndex += 1;
      continue;
    }

    nextIndex += 1;
  }
}

function stringifyJsonPointer(path: string[]): string {
  if (path.length === 0) {
    return "";
  }

  return `/${path.map(escapeJsonPointer).join("/")}`;
}

function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {
    return true;
  }

  if (a === null || b === null) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i]!, b[i]!)) {
        return false;
      }
    }

    return true;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }

    if (!jsonEquals(a[key]!, b[key]!)) {
      return false;
    }
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runScenario(width: number, runs: number): void {
  const base = buildWideObject(width);
  const next = buildNextWideObject(base, width);

  const legacyExpected = legacyDiffJsonPatch(base, next);
  const optimizedExpected = diffJsonPatch(base, next);

  // This benchmark intentionally uses flat wide objects. The inlined legacy
  // implementation replaces arrays atomically, so this guard is only valid for
  // the non-array input shape used here.
  if (JSON.stringify(legacyExpected) !== JSON.stringify(optimizedExpected)) {
    throw new Error("optimized object diff output diverged from legacy output");
  }

  const legacyStats = measure("legacy-object-diff", runs, () => {
    legacyDiffJsonPatch(base, next);
  });
  const optimizedStats = measure("optimized-object-diff", runs, () => {
    diffJsonPatch(base, next);
  });

  const speedup = legacyStats.avgMs / optimizedStats.avgMs;
  const heapDeltaReduction = legacyStats.avgHeapDeltaMb - optimizedStats.avgHeapDeltaMb;

  console.log("Object diff microbenchmark (wide objects)");
  console.log(`width=${width} runs=${runs}`);
  console.log(
    [
      "name                   avg(ms)  p50(ms)  min(ms)  max(ms)  avgHeapDelta(MB)",
      `${legacyStats.name.padEnd(22)} ${format(legacyStats.avgMs).padStart(7)} ${format(legacyStats.p50Ms).padStart(8)} ${format(legacyStats.minMs).padStart(8)} ${format(legacyStats.maxMs).padStart(8)} ${format(legacyStats.avgHeapDeltaMb).padStart(16)}`,
      `${optimizedStats.name.padEnd(22)} ${format(optimizedStats.avgMs).padStart(7)} ${format(optimizedStats.p50Ms).padStart(8)} ${format(optimizedStats.minMs).padStart(8)} ${format(optimizedStats.maxMs).padStart(8)} ${format(optimizedStats.avgHeapDeltaMb).padStart(16)}`,
    ].join("\n"),
  );
  console.log(`speedup(avg): ${format(speedup)}x`);
  console.log(`avg heap delta reduction: ${format(heapDeltaReduction)} MB`);
}

function runNestedRewriteScenario(width: number, runs: number): void {
  const base = buildWideNestedObject(width);
  const next = buildNextWideNestedRewriteObject(base, width);
  const rewriteOptions = { emitMoves: true, emitCopies: true } as const;

  const baselineOps = diffJsonPatch(base, next);
  const rewriteOps = diffJsonPatch(base, next, rewriteOptions);

  if (rewriteOps.length > 0 && !rewriteOps.every((op) => op.op === "move" || op.op === "copy")) {
    throw new Error("nested rewrite benchmark expected move/copy-only output");
  }

  const baselineStats = measure("nested-object-diff", runs, () => {
    diffJsonPatch(base, next);
  });
  const rewriteStats = measure("nested-object-diff+rewrites", runs, () => {
    diffJsonPatch(base, next, rewriteOptions);
  });
  const overhead = rewriteStats.avgMs / baselineStats.avgMs;

  console.log("");
  console.log("Object diff microbenchmark (nested rename/duplicate rewrites)");
  console.log(`width=${width} runs=${runs}`);
  console.log(`baseline op count=${baselineOps.length} rewrite op count=${rewriteOps.length}`);
  console.log(
    [
      "name                       avg(ms)  p50(ms)  min(ms)  max(ms)  avgHeapDelta(MB)",
      `${baselineStats.name.padEnd(26)} ${format(baselineStats.avgMs).padStart(7)} ${format(baselineStats.p50Ms).padStart(8)} ${format(baselineStats.minMs).padStart(8)} ${format(baselineStats.maxMs).padStart(8)} ${format(baselineStats.avgHeapDeltaMb).padStart(16)}`,
      `${rewriteStats.name.padEnd(26)} ${format(rewriteStats.avgMs).padStart(7)} ${format(rewriteStats.p50Ms).padStart(8)} ${format(rewriteStats.minMs).padStart(8)} ${format(rewriteStats.maxMs).padStart(8)} ${format(rewriteStats.avgHeapDeltaMb).padStart(16)}`,
    ].join("\n"),
  );
  console.log(`rewrite overhead(avg): ${format(overhead)}x`);
}

const width = parsePositiveIntEnv("BENCH_OBJECT_DIFF_WIDTH", 50_000);
const runs = parsePositiveIntEnv("BENCH_OBJECT_DIFF_RUNS", 6);
const rewriteWidth = parsePositiveIntEnv("BENCH_OBJECT_REWRITE_WIDTH", 5_000);

runScenario(width, runs);
runNestedRewriteScenario(rewriteWidth, runs);
