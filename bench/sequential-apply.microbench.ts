import {
  applyIntentsToCrdt,
  applyPatch,
  cloneClock,
  cloneDoc,
  compileJsonPatchToIntent,
  createState,
  materialize,
  type CrdtState,
  type JsonPatchOp,
  type JsonValue,
} from "../src/internals";

type BenchmarkStats = {
  name: string;
  samplesMs: number[];
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
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

function buildBaseDocument(size: number): JsonValue {
  return {
    list: Array.from({ length: size }, (_, idx) => idx),
    meta: {
      label: "sequential-bench",
      size,
    },
  };
}

function buildPatch(length: number, baseSize: number): JsonPatchOp[] {
  const patch: JsonPatchOp[] = [];
  for (let i = 0; i < length; i++) {
    patch.push({
      op: "replace",
      path: `/list/${i % baseSize}`,
      value: -(i + 1),
    });
  }

  return patch;
}

function cloneState(state: CrdtState): CrdtState {
  return {
    doc: cloneDoc(state.doc),
    clock: cloneClock(state.clock),
  };
}

function applyPatchLegacy(state: CrdtState, patch: JsonPatchOp[]): CrdtState {
  const next = cloneState(state);

  for (const op of patch) {
    const baseDoc = cloneDoc(next.doc);
    const baseJson = materialize(baseDoc.root);
    const intents = compileJsonPatchToIntent(baseJson, [op], {
      semantics: "sequential",
    });

    const step = applyIntentsToCrdt(
      baseDoc,
      next.doc,
      intents,
      () => next.clock.next(),
      "head",
      (ctr) => {
        if (next.clock.ctr < ctr) {
          next.clock.ctr = ctr;
        }
      },
    );
    if (!step.ok) {
      throw new Error(`legacy sequential apply failed: ${step.reason}: ${step.message}`);
    }
  }

  return next;
}

function assertEquivalentOutputs(seed: CrdtState, patch: JsonPatchOp[]): void {
  const legacy = applyPatchLegacy(seed, patch);
  const optimized = applyPatch(seed, patch, {
    semantics: "sequential",
  });

  const legacyJson = materialize(legacy.doc.root);
  const optimizedJson = materialize(optimized.doc.root);

  if (JSON.stringify(legacyJson) !== JSON.stringify(optimizedJson)) {
    throw new Error("optimized sequential path diverged from legacy output");
  }
}

function percentile(sortedValues: number[], p: number): number {
  const pos = Math.floor((sortedValues.length - 1) * p);
  return sortedValues[pos]!;
}

function measure(name: string, runs: number, fn: () => void): BenchmarkStats {
  const warmups = Math.min(3, runs);
  for (let i = 0; i < warmups; i++) {
    fn();
  }

  const samplesMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = Bun.nanoseconds();
    fn();
    const end = Bun.nanoseconds();
    samplesMs.push((end - start) / 1_000_000);
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = samplesMs.reduce((acc, value) => acc + value, 0);

  return {
    name,
    samplesMs,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    avgMs: total / samplesMs.length,
    p50Ms: percentile(sorted, 0.5),
  };
}

function format(n: number): string {
  return n.toFixed(2);
}

function main(): void {
  const baseSize = parsePositiveIntEnv("BENCH_BASE_SIZE", 2_000);
  const patchLength = parsePositiveIntEnv("BENCH_PATCH_LENGTH", 1_000);
  const runs = parsePositiveIntEnv("BENCH_RUNS", 12);

  const seed = createState(buildBaseDocument(baseSize), {
    actor: "bench",
  });
  const patch = buildPatch(patchLength, baseSize);

  assertEquivalentOutputs(seed, patch);

  const legacy = measure("legacy-per-op-clone-materialize", runs, () => {
    applyPatchLegacy(seed, patch);
  });
  const optimized = measure("optimized-applyPatch-sequential", runs, () => {
    applyPatch(seed, patch, {
      semantics: "sequential",
    });
  });

  const speedup = legacy.avgMs / optimized.avgMs;

  console.log("Sequential apply microbenchmark");
  console.log(`base size: ${baseSize}`);
  console.log(`patch length: ${patchLength}`);
  console.log(`runs: ${runs}`);
  console.log("");
  console.log(
    `${legacy.name}: avg=${format(legacy.avgMs)}ms p50=${format(legacy.p50Ms)}ms min=${format(legacy.minMs)}ms max=${format(legacy.maxMs)}ms`,
  );
  console.log(
    `${optimized.name}: avg=${format(optimized.avgMs)}ms p50=${format(optimized.p50Ms)}ms min=${format(optimized.minMs)}ms max=${format(optimized.maxMs)}ms`,
  );
  console.log(`speedup (avg): ${format(speedup)}x`);
}

main();
