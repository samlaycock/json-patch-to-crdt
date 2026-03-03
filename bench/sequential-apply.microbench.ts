import {
  applyIntentsToCrdt,
  applyPatch,
  cloneClock,
  cloneDoc,
  compileJsonPatchToIntent,
  createState,
  getAtJson,
  materialize,
  parseJsonPointer,
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

type BenchmarkScenario = {
  name: string;
  baseSize: number;
  patchLength: number;
  runs: number;
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

function buildExplicitBaseDocument(size: number): JsonValue {
  return {
    meta: {
      version: 0,
      label: "sequential-explicit-base-bench",
    },
    hot: {
      a: {
        b: {
          c: {
            d: {
              value: 0,
            },
          },
        },
      },
    },
    cold: {
      values: Array.from({ length: size }, (_, idx) => idx),
    },
  };
}

function buildExplicitBasePatch(iterations: number): JsonPatchOp[] {
  const patch: JsonPatchOp[] = [];

  for (let i = 0; i < iterations; i++) {
    patch.push({
      op: "replace",
      path: "/hot/a/b/c/d/value",
      value: i + 20_000,
    });
    patch.push({
      op: "test",
      path: "/meta/version",
      value: 0,
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

function applyPatchLegacyExplicitBase(
  head: CrdtState,
  base: CrdtState,
  patch: JsonPatchOp[],
): CrdtState {
  const next = cloneState(head);
  const explicitBase = cloneState(base);
  let shadowBaseJson = materialize(explicitBase.doc.root);

  for (const op of patch) {
    if (op.op === "move" || op.op === "copy") {
      throw new Error("legacy explicit-base benchmark only supports add/remove/replace/test ops");
    }

    const intents = compileJsonPatchToIntent(shadowBaseJson, [op], {
      semantics: "sequential",
    });

    const headStep = applyIntentsToCrdt(
      explicitBase.doc,
      next.doc,
      intents,
      () => next.clock.next(),
      "base",
      (ctr) => bumpClock(next, ctr),
    );
    if (!headStep.ok) {
      throw new Error(
        `legacy explicit-base sequential apply failed on head: ${headStep.reason}: ${headStep.message}`,
      );
    }

    if (op.op !== "test") {
      const shadowStep = applyIntentsToCrdt(
        explicitBase.doc,
        explicitBase.doc,
        intents,
        () => explicitBase.clock.next(),
        "base",
        (ctr) => bumpClock(explicitBase, ctr),
      );
      if (!shadowStep.ok) {
        throw new Error(
          `legacy explicit-base sequential apply failed on shadow: ${shadowStep.reason}: ${shadowStep.message}`,
        );
      }

      shadowBaseJson = applyShadowPatchOpLegacy(shadowBaseJson, op);
    }
  }

  return next;
}

function applyShadowPatchOpLegacy(
  baseJson: JsonValue,
  op: Exclude<JsonPatchOp, { op: "copy" | "move" }>,
): JsonValue {
  const path = parseJsonPointer(op.path);
  if (path.length === 0) {
    if (op.op === "remove") {
      return null;
    }

    if (op.op === "test") {
      return baseJson;
    }

    return structuredClone(op.value);
  }

  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1]!;
  const parent = getAtJson(baseJson, parentPath);

  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index)) {
      throw new Error(`legacy shadow apply got invalid array index '${key}'`);
    }

    if (op.op === "add") {
      parent.splice(index, 0, structuredClone(op.value));
      return baseJson;
    }

    if (op.op === "remove") {
      parent.splice(index, 1);
      return baseJson;
    }

    if (op.op === "replace") {
      parent[index] = structuredClone(op.value);
      return baseJson;
    }

    return baseJson;
  }

  const objectParent = parent as Record<string, JsonValue>;

  if (op.op === "add" || op.op === "replace") {
    objectParent[key] = structuredClone(op.value);
    return baseJson;
  }

  if (op.op === "remove") {
    delete objectParent[key];
  }

  return baseJson;
}

function bumpClock(state: CrdtState, ctr: number): void {
  if (state.clock.ctr < ctr) {
    state.clock.ctr = ctr;
  }
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

function assertEquivalentExplicitBaseOutputs(
  head: CrdtState,
  base: CrdtState,
  patch: JsonPatchOp[],
): void {
  const legacy = applyPatchLegacyExplicitBase(head, base, patch);
  const optimized = applyPatch(head, patch, {
    base,
    semantics: "sequential",
    testAgainst: "base",
  });

  const legacyJson = materialize(legacy.doc.root);
  const optimizedJson = materialize(optimized.doc.root);

  if (JSON.stringify(legacyJson) !== JSON.stringify(optimizedJson)) {
    throw new Error("optimized explicit-base sequential path diverged from legacy output");
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

function resolveScenarios(): BenchmarkScenario[] {
  const hasCustomScenario =
    Bun.env.BENCH_BASE_SIZE !== undefined ||
    Bun.env.BENCH_PATCH_LENGTH !== undefined ||
    Bun.env.BENCH_RUNS !== undefined;
  if (hasCustomScenario) {
    return [
      {
        name: "custom",
        baseSize: parsePositiveIntEnv("BENCH_BASE_SIZE", 2_000),
        patchLength: parsePositiveIntEnv("BENCH_PATCH_LENGTH", 1_000),
        runs: parsePositiveIntEnv("BENCH_RUNS", 12),
      },
    ];
  }

  return [
    {
      name: "medium",
      baseSize: 2_000,
      patchLength: 1_000,
      runs: 12,
    },
    {
      name: "large",
      baseSize: 8_000,
      patchLength: 4_000,
      runs: 8,
    },
  ];
}

function main(): void {
  const scenarios = resolveScenarios();

  console.log("Sequential apply microbenchmark");
  for (const scenario of scenarios) {
    const seed = createState(buildBaseDocument(scenario.baseSize), {
      actor: "bench",
    });
    const patch = buildPatch(scenario.patchLength, scenario.baseSize);

    assertEquivalentOutputs(seed, patch);

    const legacy = measure("legacy-per-op-clone-materialize", scenario.runs, () => {
      applyPatchLegacy(seed, patch);
    });
    const optimized = measure("optimized-applyPatch-sequential", scenario.runs, () => {
      applyPatch(seed, patch, {
        semantics: "sequential",
      });
    });
    const speedup = legacy.avgMs / optimized.avgMs;

    const explicitBase = createState(buildExplicitBaseDocument(scenario.baseSize), {
      actor: "bench-base",
    });
    const explicitHead = applyPatch(
      explicitBase,
      [{ op: "replace", path: "/meta/version", value: 1 }],
      { semantics: "sequential" },
    );
    const explicitPatch = buildExplicitBasePatch(Math.max(1, Math.floor(scenario.patchLength / 2)));

    assertEquivalentExplicitBaseOutputs(explicitHead, explicitBase, explicitPatch);

    const explicitLegacy = measure(
      "legacy-explicit-base-per-op-compile-shadow",
      scenario.runs,
      () => {
        applyPatchLegacyExplicitBase(explicitHead, explicitBase, explicitPatch);
      },
    );
    const explicitOptimized = measure("optimized-explicit-base-session", scenario.runs, () => {
      applyPatch(explicitHead, explicitPatch, {
        base: explicitBase,
        semantics: "sequential",
        testAgainst: "base",
      });
    });
    const explicitSpeedup = explicitLegacy.avgMs / explicitOptimized.avgMs;

    console.log("");
    console.log(
      `[${scenario.name}] base size=${scenario.baseSize} patch length=${scenario.patchLength}`,
    );
    console.log(`runs: ${scenario.runs}`);
    console.log(
      `${legacy.name}: avg=${format(legacy.avgMs)}ms p50=${format(legacy.p50Ms)}ms min=${format(legacy.minMs)}ms max=${format(legacy.maxMs)}ms`,
    );
    console.log(
      `${optimized.name}: avg=${format(optimized.avgMs)}ms p50=${format(optimized.p50Ms)}ms min=${format(optimized.minMs)}ms max=${format(optimized.maxMs)}ms`,
    );
    console.log(`speedup (avg): ${format(speedup)}x`);
    console.log(
      `${explicitLegacy.name}: avg=${format(explicitLegacy.avgMs)}ms p50=${format(explicitLegacy.p50Ms)}ms min=${format(explicitLegacy.minMs)}ms max=${format(explicitLegacy.maxMs)}ms`,
    );
    console.log(
      `${explicitOptimized.name}: avg=${format(explicitOptimized.avgMs)}ms p50=${format(explicitOptimized.p50Ms)}ms min=${format(explicitOptimized.minMs)}ms max=${format(explicitOptimized.maxMs)}ms`,
    );
    console.log(`explicit-base speedup (avg): ${format(explicitSpeedup)}x`);
  }
}

main();
