import { describe, expect, it } from "bun:test";

import type { JsonPatchOp, JsonValue } from "../src";

import { applyPatch, compactStateTombstones, createState, diffJsonPatch, toJson } from "../src";
import { compileJsonPatchToIntent } from "../src/internals";

describe("performance regressions", () => {
  it("falls back to atomic replace for very large LCS matrices", () => {
    const baseArr = Array.from({ length: 1_500 }, (_, idx) => idx);
    const nextArr = [...baseArr];
    nextArr[750] = -1;

    const base: JsonValue = { arr: baseArr };
    const next: JsonValue = { arr: nextArr };
    const patch = diffJsonPatch(base, next);

    expect(patch).toEqual([{ op: "replace", path: "/arr", value: nextArr }]);
  });

  it("keeps sequential long-patch semantics stable on large arrays", () => {
    const base = createState(
      {
        list: Array.from({ length: 500 }, (_, idx) => idx),
      },
      { actor: "perf" },
    );
    const patch: JsonPatchOp[] = [];
    for (let i = 0; i < 400; i++) {
      patch.push({
        op: "replace",
        path: `/list/${i}`,
        value: i + 1_000,
      });
    }

    const next = applyPatch(base, patch, { semantics: "sequential" });
    const json = toJson(next) as { list: number[] };

    expect(json.list[0]).toBe(1_000);
    expect(json.list[399]).toBe(1_399);
    expect(json.list[499]).toBe(499);
  });

  it("keeps sequential add/remove batches aligned on evolving snapshots", () => {
    const base = createState(
      {
        list: Array.from({ length: 200 }, (_, idx) => idx),
      },
      { actor: "perf" },
    );
    const patch: JsonPatchOp[] = [];
    for (let i = 0; i < 150; i++) {
      patch.push({ op: "add", path: "/list/0", value: -(i + 1) });
      patch.push({ op: "remove", path: "/list/1" });
    }

    const next = applyPatch(base, patch, {
      semantics: "sequential",
      testAgainst: "base",
    });
    const json = toJson(next) as { list: number[] };

    expect(json.list).toHaveLength(200);
    expect(json.list[0]).toBe(-150);
    expect(json.list[1]).toBe(1);
    expect(json.list[199]).toBe(199);
  });

  it("avoids cloning the full base document when compiling sequential patches", () => {
    const base: JsonValue = {
      touched: { list: [1, 2, 3] },
      untouched: {
        huge: Array.from({ length: 2_000 }, (_, idx) => ({ idx, value: `v${idx}` })),
      },
    };
    const patch: JsonPatchOp[] = [{ op: "replace", path: "/touched/list/0", value: 99 }];
    const originalStructuredClone = globalThis.structuredClone;
    const clonedInputs: unknown[] = [];

    globalThis.structuredClone = ((value: unknown, options?: unknown) => {
      clonedInputs.push(value);
      return (originalStructuredClone as (input: unknown, cloneOptions?: unknown) => unknown)(
        value,
        options,
      );
    }) as typeof structuredClone;

    try {
      expect(compileJsonPatchToIntent(base, patch, { semantics: "sequential" })).toEqual([
        { t: "ArrReplace", path: ["touched", "list"], index: 0, value: 99 },
      ]);
    } finally {
      globalThis.structuredClone = originalStructuredClone;
    }

    expect(clonedInputs.includes(base)).toBe(false);
  });

  it("compacts high-volume stable tombstones without changing materialized output", () => {
    const initial: Record<string, JsonValue> = {};
    for (let i = 0; i < 400; i++) {
      initial[`k${i}`] = i;
    }

    const base = createState({ obj: initial }, { actor: "gc" });
    const removals: JsonPatchOp[] = [];
    for (let i = 0; i < 300; i++) {
      removals.push({ op: "remove", path: `/obj/k${i}` });
    }

    const removed = applyPatch(base, removals, { semantics: "sequential" });
    const before = toJson(removed);

    const compacted = compactStateTombstones(removed, {
      stable: { gc: removed.clock.ctr },
    });

    expect(compacted.stats.objectTombstonesRemoved).toBeGreaterThanOrEqual(300);
    expect(toJson(compacted.state)).toEqual(before);
  });
});
