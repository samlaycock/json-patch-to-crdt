import {
  diffJsonPatch,
  type DiffOptions,
  type JsonPatchOp,
  type JsonValue,
} from "../src/internals";

type BenchmarkStats = {
  name: string;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  avgHeapDeltaMb: number;
};

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }

  return parsed;
}

function percentile(sortedValues: number[], p: number): number {
  const position = Math.floor((sortedValues.length - 1) * p);
  return sortedValues[position]!;
}

function format(value: number): string {
  return value.toFixed(2);
}

function measure(name: string, runs: number, fn: () => JsonPatchOp[]): BenchmarkStats {
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

  const sorted = [...samplesMs].sort((left, right) => left - right);
  const total = samplesMs.reduce((sum, value) => sum + value, 0);
  const nonNegativeHeapDeltasMb = heapDeltasMb.filter((value) => value >= 0);

  return {
    name,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    avgMs: total / samplesMs.length,
    p50Ms: percentile(sorted, 0.5),
    avgHeapDeltaMb:
      nonNegativeHeapDeltasMb.reduce((sum, value) => sum + value, 0) /
      Math.max(1, nonNegativeHeapDeltasMb.length),
  };
}

function buildLocalizedArrayEdit(length: number): { base: JsonValue; next: JsonValue } {
  const baseArray = Array.from({ length }, (_, idx) => idx);
  const nextArray = [...baseArray];
  nextArray[Math.floor(length / 2)] = -1;

  return {
    base: { arr: baseArray },
    next: { arr: nextArray },
  };
}

function buildRotateLeftArrayEdit(length: number): { base: JsonValue; next: JsonValue } {
  const baseArray = Array.from({ length }, (_, idx) => idx);
  const nextArray = [...baseArray.slice(1), baseArray[0]!];

  return {
    base: { arr: baseArray },
    next: { arr: nextArray },
  };
}

function runDiff(base: JsonValue, next: JsonValue, options: DiffOptions): JsonPatchOp[] {
  return diffJsonPatch(base, next, options);
}

function summarizePatchOp(op: JsonPatchOp | undefined): string {
  if (!op) {
    return "none";
  }

  if ((op.op === "add" || op.op === "replace") && Array.isArray(op.value)) {
    return JSON.stringify({
      op: op.op,
      path: op.path,
      valueSummary: `array(${op.value.length})`,
    });
  }

  return JSON.stringify(op);
}

function logTable(stats: BenchmarkStats[]): void {
  console.log(
    [
      "name                     avg(ms)  p50(ms)  min(ms)  max(ms)  avgHeapDelta(MB)",
      ...stats.map(
        (stat) =>
          `${stat.name.padEnd(24)} ${format(stat.avgMs).padStart(7)} ${format(stat.p50Ms).padStart(8)} ${format(stat.minMs).padStart(8)} ${format(stat.maxMs).padStart(8)} ${format(stat.avgHeapDeltaMb).padStart(16)}`,
      ),
    ].join("\n"),
  );
}

function runMatrixVsLinearScenario(length: number, runs: number): void {
  const { base, next } = buildLocalizedArrayEdit(length);
  const matrixOptions: DiffOptions = {
    arrayStrategy: "lcs",
    lcsMaxCells: Number.POSITIVE_INFINITY,
  };
  const linearOptions: DiffOptions = {
    arrayStrategy: "lcs-linear",
  };

  const matrixPatch = runDiff(base, next, matrixOptions);
  const linearPatch = runDiff(base, next, linearOptions);

  if (JSON.stringify(matrixPatch) !== JSON.stringify(linearPatch)) {
    throw new Error("matrix and linear-space patches diverged for the localized edit benchmark");
  }

  const matrixStats = measure("lcs-matrix", runs, () => runDiff(base, next, matrixOptions));
  const linearStats = measure("lcs-linear", runs, () => runDiff(base, next, linearOptions));

  console.log("Array diff microbenchmark (localized single-element edit)");
  console.log(`length=${length} runs=${runs}`);
  logTable([matrixStats, linearStats]);
  console.log(
    `avg heap delta reduction: ${format(matrixStats.avgHeapDeltaMb - linearStats.avgHeapDeltaMb)} MB`,
  );
}

function runGuardrailScenario(length: number): void {
  const { base, next } = buildRotateLeftArrayEdit(length);
  const classicPatch = runDiff(base, next, { arrayStrategy: "lcs" });
  const linearPatch = runDiff(base, next, { arrayStrategy: "lcs-linear" });

  console.log("Guardrail comparison (rotate-left edit, default options)");
  console.log(`length=${length}`);
  console.log(`lcs ops: ${classicPatch.length} ${summarizePatchOp(classicPatch[0])}`);
  console.log(
    `lcs-linear ops: ${linearPatch.length} first=${summarizePatchOp(linearPatch[0])} last=${summarizePatchOp(linearPatch[linearPatch.length - 1])}`,
  );
}

const mediumLength = parsePositiveIntEnv("BENCH_ARRAY_DIFF_MEDIUM_SIZE", 1_800);
const largeLength = parsePositiveIntEnv("BENCH_ARRAY_DIFF_LARGE_SIZE", 4_000);
const runs = parsePositiveIntEnv("BENCH_ARRAY_DIFF_RUNS", 12);

runMatrixVsLinearScenario(mediumLength, runs);
console.log("");
runGuardrailScenario(largeLength);
