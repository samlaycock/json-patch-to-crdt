import { describe, expect, it } from "bun:test";

import type { JsonPatchOp, JsonValue } from "../src";

import { applyPatch, createState, diffJsonPatch, toJson } from "../src";
import { docFromJson, stringifyJsonPointer, tryMergeDoc } from "../src/internals";

interface PerfGate {
  readonly name: string;
  readonly thresholdEnv: string;
  readonly defaultThresholdMs: number;
  readonly run: () => void;
}

interface PerfResult {
  readonly name: string;
  readonly medianMs: number;
  readonly thresholdMs: number;
  readonly samplesMs: readonly number[];
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`);
  }

  return parsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function measureGate(gate: PerfGate): PerfResult {
  const runs = parsePositiveNumberEnv("PERF_GATE_RUNS", 5);
  const thresholdMs = parsePositiveNumberEnv(gate.thresholdEnv, gate.defaultThresholdMs);

  gate.run();

  const samplesMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const startedAt = Bun.nanoseconds();
    gate.run();
    const endedAt = Bun.nanoseconds();
    samplesMs.push((endedAt - startedAt) / 1_000_000);
  }

  return {
    name: gate.name,
    medianMs: median(samplesMs),
    thresholdMs,
    samplesMs,
  };
}

function assertWithinGate(result: PerfResult, thresholdEnv: string): void {
  expect(
    result.medianMs,
    [
      `${result.name} exceeded its perf gate.`,
      `median=${result.medianMs.toFixed(2)}ms threshold=${result.thresholdMs.toFixed(2)}ms`,
      `samples=${result.samplesMs.map((sample) => sample.toFixed(2)).join(",")}ms`,
      `If this is an intentional environment-specific adjustment, tune ${thresholdEnv}.`,
    ].join(" "),
  ).toBeLessThanOrEqual(result.thresholdMs);
}

function buildDeepObject(depth: number): JsonValue {
  const leafKey = "a~b/c";
  return Array.from({ length: depth }).reduce<JsonValue>((value) => ({ child: value }), {
    [leafKey]: [1],
  });
}

describe("CI performance gates", () => {
  it("keeps array diffing within the fixed-size smoke budget", () => {
    const baseArr = Array.from({ length: 1_500 }, (_, idx) => idx);
    const nextArr = [...baseArr];
    nextArr[750] = -1;
    const base: JsonValue = { arr: baseArr };
    const next: JsonValue = { arr: nextArr };
    const expectedPatch: JsonPatchOp[] = [{ op: "replace", path: "/arr/750", value: -1 }];

    const gate: PerfGate = {
      name: "array diffing",
      thresholdEnv: "PERF_GATE_ARRAY_DIFF_MS",
      defaultThresholdMs: 250,
      run: () => {
        expect(diffJsonPatch(base, next)).toEqual(expectedPatch);
      },
    };

    const result = measureGate(gate);
    assertWithinGate(result, gate.thresholdEnv);
  });

  it("keeps merge traversal within the fixed-size smoke budget", () => {
    const depth = 2_000;
    const value = buildDeepObject(depth);
    const expectedPath = stringifyJsonPointer([
      ...Array.from({ length: depth }, () => "child"),
      "a~b/c",
    ]);

    const gate: PerfGate = {
      name: "merge traversal",
      thresholdEnv: "PERF_GATE_MERGE_TRAVERSAL_MS",
      defaultThresholdMs: 1_000,
      run: () => {
        const result = tryMergeDoc(
          docFromJson(value, () => ({ actor: "A", ctr: 1 })),
          docFromJson(value, () => ({ actor: "B", ctr: 1 })),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.path).toBe(expectedPath);
        }
      },
    };

    const result = measureGate(gate);
    assertWithinGate(result, gate.thresholdEnv);
  });

  it("keeps sequential patch application within the fixed-size smoke budget", () => {
    const base = createState(
      {
        list: Array.from({ length: 500 }, (_, idx) => idx),
      },
      { actor: "perf-gate" },
    );
    const patch: JsonPatchOp[] = Array.from({ length: 400 }, (_, idx) => ({
      op: "replace",
      path: `/list/${idx}`,
      value: idx + 1_000,
    }));

    const gate: PerfGate = {
      name: "sequential patch application",
      thresholdEnv: "PERF_GATE_SEQUENTIAL_APPLY_MS",
      defaultThresholdMs: 500,
      run: () => {
        const next = applyPatch(base, patch, { semantics: "sequential" });
        const json = toJson(next) as { list: number[] };

        expect(json.list[0]).toBe(1_000);
        expect(json.list[399]).toBe(1_399);
        expect(json.list[499]).toBe(499);
      },
    };

    const result = measureGate(gate);
    assertWithinGate(result, gate.thresholdEnv);
  });
});
