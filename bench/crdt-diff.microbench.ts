import {
  applyPatch,
  createState,
  crdtToJsonPatch,
  diffJsonPatch,
  materialize,
  type DiffOptions,
  type Doc,
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
  // GC can make a single-run heap delta negative, so exclude those noisy samples.
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

function legacyCrdtToJsonPatch(base: Doc, head: Doc, options?: DiffOptions): JsonPatchOp[] {
  return diffJsonPatch(materialize(base.root), materialize(head.root), options);
}

function buildMostlyUnchangedSnapshot(coldSize: number): JsonValue {
  return {
    hot: {
      version: 0,
      toggled: false,
    },
    cold: {
      items: Array.from({ length: coldSize }, (_, idx) => ({
        id: idx,
        text: `item-${idx}`,
        nested: {
          even: idx % 2 === 0,
          tags: [idx % 7, idx % 11, idx % 13],
        },
      })),
    },
  };
}

function runScenario(coldSize: number, runs: number): void {
  const base = createState(buildMostlyUnchangedSnapshot(coldSize), {
    actor: "bench",
  });

  const patch: JsonPatchOp[] = [
    { op: "replace", path: "/hot/version", value: 1 },
    { op: "replace", path: "/hot/toggled", value: true },
  ];
  const head = applyPatch(base, patch, { semantics: "sequential" });

  const options: DiffOptions = {
    arrayStrategy: "lcs",
  };

  const expected = legacyCrdtToJsonPatch(base.doc, head.doc, options);
  const native = crdtToJsonPatch(base.doc, head.doc, options);
  // Both paths preserve deterministic op ordering, so this is enough for a smoke check.
  if (JSON.stringify(expected) !== JSON.stringify(native)) {
    throw new Error("native crdtToJsonPatch output diverged from legacy diff");
  }

  const legacyStats = measure("legacy-materialize-both", runs, () => {
    legacyCrdtToJsonPatch(base.doc, head.doc, options);
  });
  const nativeStats = measure("native-crdt-diff", runs, () => {
    crdtToJsonPatch(base.doc, head.doc, options);
  });

  const speedup = legacyStats.avgMs / nativeStats.avgMs;
  const heapDeltaReduction = legacyStats.avgHeapDeltaMb - nativeStats.avgHeapDeltaMb;

  console.log("CRDT diff microbenchmark (mostly unchanged large docs)");
  console.log(`coldSize=${coldSize} runs=${runs}`);
  console.log(
    [
      "name                     avg(ms)  p50(ms)  min(ms)  max(ms)  avgHeapDelta(MB)",
      `${legacyStats.name.padEnd(24)} ${format(legacyStats.avgMs).padStart(7)} ${format(legacyStats.p50Ms).padStart(8)} ${format(legacyStats.minMs).padStart(8)} ${format(legacyStats.maxMs).padStart(8)} ${format(legacyStats.avgHeapDeltaMb).padStart(16)}`,
      `${nativeStats.name.padEnd(24)} ${format(nativeStats.avgMs).padStart(7)} ${format(nativeStats.p50Ms).padStart(8)} ${format(nativeStats.minMs).padStart(8)} ${format(nativeStats.maxMs).padStart(8)} ${format(nativeStats.avgHeapDeltaMb).padStart(16)}`,
    ].join("\n"),
  );
  console.log(`speedup(avg): ${format(speedup)}x`);
  console.log(`avg heap delta reduction: ${format(heapDeltaReduction)} MB`);
}

const coldSize = parsePositiveIntEnv("BENCH_DIFF_COLD_SIZE", 15_000);
const runs = parsePositiveIntEnv("BENCH_DIFF_RUNS", 12);

runScenario(coldSize, runs);
