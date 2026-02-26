import { describe, expect, it } from "bun:test";

import type { JsonPatchOp, JsonValue } from "../src";
import type { IntentOp, RgaElem, RgaSeq } from "../src/internals";

import { applyPatch, compactStateTombstones, createState, diffJsonPatch, toJson } from "../src";
import {
  applyIntentsToCrdt,
  cloneDoc,
  compileJsonPatchToIntent,
  docFromJson,
} from "../src/internals";

describe("performance regressions", () => {
  it("diffs large arrays with a narrow changed window without full-array replace", () => {
    const baseArr = Array.from({ length: 1_500 }, (_, idx) => idx);
    const nextArr = [...baseArr];
    nextArr[750] = -1;

    const base: JsonValue = { arr: baseArr };
    const next: JsonValue = { arr: nextArr };
    const patch = diffJsonPatch(base, next);

    expect(patch).toEqual([{ op: "replace", path: "/arr/750", value: -1 }]);
  });

  it("still falls back to atomic replace when the unmatched LCS window is too large", () => {
    const baseArr = Array.from({ length: 600 }, (_, idx) => idx);
    const nextArr = [...baseArr].reverse();

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
  it("keeps explicit-base sequential move batches aligned on long patches", () => {
    const base = createState(
      {
        meta: 0,
        list: Array.from({ length: 250 }, (_, idx) => idx),
      },
      { actor: "perf" },
    );
    const head = applyPatch(base, [{ op: "replace", path: "/meta", value: 1 }]);

    const patch: JsonPatchOp[] = [];
    for (let i = 0; i < 120; i++) {
      patch.push({ op: "move", from: "/list/0", path: "/list/-" });
      patch.push({ op: "test", path: "/meta", value: 0 });
    }

    const next = applyPatch(head, patch, {
      base,
      semantics: "sequential",
      testAgainst: "base",
    });
    const json = toJson(next) as { meta: number; list: number[] };
    const expected = toJson(applyPatch(base, patch, { semantics: "sequential" })) as {
      meta: number;
      list: number[];
    };

    expect(json.list).toEqual(expected.list);
    expect(json.meta).toBe(1);
  });

  it("handles many test ops without materializing unrelated large branches", () => {
    const base = createState(
      {
        meta: { version: 0 },
        list: Array.from({ length: 200 }, (_, idx) => idx),
        untouched: {
          huge: Array.from({ length: 2_500 }, (_, idx) => ({
            idx,
            nested: { label: `v${idx}`, even: idx % 2 === 0 },
          })),
        },
      },
      { actor: "perf" },
    );

    const patch: JsonPatchOp[] = [];
    for (let i = 0; i < 200; i++) {
      patch.push({ op: "test", path: "/meta/version", value: 0 });
      patch.push({ op: "replace", path: `/list/${i}`, value: i + 10_000 });
    }

    const next = applyPatch(base, patch, { semantics: "sequential", testAgainst: "base" });
    const json = toJson(next) as {
      meta: { version: number };
      list: number[];
      untouched: { huge: Array<{ idx: number; nested: { label: string; even: boolean } }> };
    };

    expect(json.meta.version).toBe(0);
    expect(json.list[0]).toBe(10_000);
    expect(json.list[199]).toBe(10_199);
    expect(json.untouched.huge[2_499]).toEqual({
      idx: 2_499,
      nested: { label: "v2499", even: false },
    });
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

  it("materializes nested documents without Array.from traversal snapshots", () => {
    const state = createState(
      {
        meta: { name: "doc", flags: { ready: true } },
        items: Array.from({ length: 150 }, (_, idx) => ({
          id: idx,
          nested: { value: `v${idx}`, list: [idx, idx + 1] },
        })),
      },
      { actor: "perf" },
    );
    const originalArrayFrom = Array.from;
    let arrayFromCalls = 0;

    Array.from = ((...args: unknown[]) => {
      arrayFromCalls += 1;
      return Reflect.apply(originalArrayFrom, Array, args);
    }) as typeof Array.from;

    try {
      const json = toJson(state) as {
        meta: { name: string; flags: { ready: boolean } };
        items: Array<{ id: number; nested: { value: string; list: number[] } }>;
      };

      expect(json.meta.flags.ready).toBe(true);
      expect(json.items).toHaveLength(150);
      expect(json.items[149]).toEqual({
        id: 149,
        nested: { value: "v149", list: [149, 150] },
      });
    } finally {
      Array.from = originalArrayFrom;
    }

    expect(arrayFromCalls).toBe(0);
  });

  it("avoids full-sequence sibling scans on repeated array appends", () => {
    let ctr = 0;
    const nextDot = () => ({ actor: "perf", ctr: ++ctr });
    const base = docFromJson({ list: Array.from({ length: 200 }, (_, idx) => idx) }, nextDot);
    const head = cloneDoc(base);
    const listEntry = head.root.kind === "obj" ? head.root.entries.get("list") : undefined;
    expect(listEntry?.node.kind).toBe("seq");

    const seq = listEntry!.node as RgaSeq;
    const elems = seq.elems as Map<string, RgaElem> & { values: typeof seq.elems.values };
    const originalValues = elems.values;
    let valuesCalls = 0;

    elems.values = function values(this: Map<string, RgaElem>) {
      valuesCalls += 1;
      return originalValues.call(this);
    };

    try {
      const intents: IntentOp[] = Array.from({ length: 120 }, (_, idx) => ({
        t: "ArrInsert",
        path: ["list"],
        index: Number.POSITIVE_INFINITY,
        value: 10_000 + idx,
      }));

      const result = applyIntentsToCrdt(base, head, intents, nextDot);
      expect(result.ok).toBe(true);
    } finally {
      elems.values = originalValues;
    }

    expect(valuesCalls).toBeLessThanOrEqual(3);
  });
});
