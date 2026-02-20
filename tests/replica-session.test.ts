/* oxlint-disable no-unused-vars */
import { describe, expect, it } from "bun:test";

import type { SerializedSyncRecord, SyncEnvelope, SyncJson, SyncRecord } from "./test-utils";

import {
  applyIntentsToCrdt,
  applyPatch,
  applyPatchAsActor,
  applyPatchInPlace,
  compactDocTombstones,
  compactStateTombstones,
  tryApplyPatch,
  tryApplyPatchInPlace,
  validateJsonPatch,
  cloneClock,
  compareDot,
  compileJsonPatchToIntent,
  diffJsonPatch,
  createClock,
  nextDotForActor,
  observeDot,
  createState,
  forkState,
  crdtToJsonPatch,
  crdtToFullReplace,
  cloneDoc,
  docFromJson,
  docFromJsonWithDot,
  dotToElemId,
  getAtJson,
  jsonPatchToCrdt,
  jsonPatchToCrdtSafe,
  lwwSet,
  materialize,
  newObj,
  newReg,
  newSeq,
  objRemove,
  objSet,
  PatchCompileError,
  PatchError,
  DeserializeError,
  TraversalDepthError,
  parseJsonPointer,
  stringifyJsonPointer,
  rgaDelete,
  rgaInsertAfter,
  rgaLinearizeIds,
  rgaPrevForInsertAtIndex,
  serializeDoc,
  serializeState,
  deserializeDoc,
  deserializeState,
  mergeDoc,
  MergeError,
  mergeState,
  tryMergeDoc,
  tryMergeState,
  toJson,
  vvHasDot,
  vvMerge,
  type Dot,
  type SerializedDoc,
  type IntentOp,
  MAX_TRAVERSAL_DEPTH,
  ROOT_KEY,
  HEAD,
  type CrdtState,
  type Doc,
  type JsonPatchOp,
  type JsonValue,
  type VersionVector,
} from "../src/internals";
import {
  SeededRng,
  applyIncomingPatch,
  applyIncomingWithDedupe,
  applyJsonPatch,
  asSyncJson,
  cloneJson,
  cloneVv,
  compactHistory,
  createSyncRecord,
  dot,
  expectDeltaApplies,
  makeDeepObject,
  makeDeepObjectNode,
  maxVvCtr,
  newDotGen,
  randomArray,
  randomObject,
  randomObjectWithOrder,
  randomSyncPatchForSnapshot,
  randomValidPatchProgram,
  randomValue,
  readDeepObjectLeaf,
  deserializeSyncRecord,
  serializeSyncRecord,
  snapshotFromRecord,
  versionKey,
} from "./test-utils";

describe("replica session flows", () => {
  it("emits a latest delta from a prior snapshot", () => {
    const record = createSyncRecord({ count: 0, list: ["a"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/count", value: 1 }]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "add", path: "/list/-", value: "b" },
    ]);

    expect(materialize(record.head.root)).toEqual({ count: 1, list: ["a", "b"] });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("resolves array replacements using referenced snapshot element identities", () => {
    const record = createSyncRecord({ list: ["a", "b", "c"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "add", path: "/list/0", value: "x" }]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "replace", path: "/list/1", value: "B" },
    ]);

    expect(materialize(record.head.root)).toEqual({ list: ["x", "a", "B", "c"] });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("surfaces a missing target when replacing a no-longer-live element", () => {
    const record = createSyncRecord({ list: ["a", "b"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "remove", path: "/list/1" }]);

    try {
      applyIncomingPatch(record, "B", base, [{ op: "replace", path: "/list/1", value: "B" }]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      if (error instanceof PatchError) {
        expect(error.reason).toBe("MISSING_TARGET");
        expect(error.path).toBe("/list/1");
      }
      return;
    }

    throw new Error("Expected PatchError");
  });

  it("supports assertions against the referenced snapshot", () => {
    const record = createSyncRecord({ v: 1 });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/v", value: 2 }]);
    applyIncomingPatch(
      record,
      "B",
      base,
      [
        { op: "test", path: "/v", value: 1 },
        { op: "replace", path: "/v", value: 3 },
      ],
      { testAgainst: "base" },
    );

    expect(materialize(record.head.root)).toEqual({ v: 3 });
  });

  it("fails assertions against the current state when values diverge", () => {
    const record = createSyncRecord({ v: 1 });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/v", value: 2 }]);

    try {
      applyIncomingPatch(record, "B", base, [
        { op: "test", path: "/v", value: 1 },
        { op: "replace", path: "/v", value: 3 },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      if (error instanceof PatchError) {
        expect(error.reason).toBe("TEST_FAILED");
      }
      return;
    }

    throw new Error("Expected PatchError");
  });

  it("applies move operations from referenced snapshots after unrelated appends", () => {
    const record = createSyncRecord({ list: ["a", "b", "c"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "add", path: "/list/-", value: "d" }]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "move", from: "/list/2", path: "/list/0" },
    ]);

    const list = (materialize(record.head.root) as { list: string[] }).list;
    expect(list[0]).toBe("c");
    expect(list).toContain("a");
    expect(list).toContain("b");
    expect(list).toContain("d");
    expect(list.length).toBe(4);
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("applies copy operations from referenced snapshots after key updates", () => {
    const record = createSyncRecord({ obj: { a: 1, b: 2 } });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/obj/a", value: 10 }]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "copy", from: "/obj/b", path: "/obj/c" },
    ]);

    expect(materialize(record.head.root)).toEqual({
      obj: {
        a: 10,
        b: 2,
        c: 2,
      },
    });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("supports compound sequential patch programs from prior snapshots", () => {
    const record = createSyncRecord({ arr: [1, 2], obj: { a: 1, b: 2 } });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/arr/0", value: 10 }]);
    const second = applyIncomingPatch(
      record,
      "B",
      base,
      [
        { op: "replace", path: "/obj/b", value: 20 },
        { op: "add", path: "/arr/1", value: 99 },
      ],
      { semantics: "sequential" },
    );

    expect(materialize(record.head.root)).toEqual({
      arr: [10, 99, 2],
      obj: { a: 1, b: 20 },
    });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("keeps independent records isolated", () => {
    const left = createSyncRecord({ doc: "left", count: 0 });
    const right = createSyncRecord({ doc: "right", count: 100 });

    const leftBase = cloneVv(left.vv);
    const rightBase = cloneVv(right.vv);

    applyIncomingPatch(left, "A", leftBase, [{ op: "replace", path: "/count", value: 1 }]);
    applyIncomingPatch(right, "B", rightBase, [{ op: "replace", path: "/count", value: 101 }]);

    const leftSecond = applyIncomingPatch(left, "C", leftBase, [
      { op: "replace", path: "/count", value: 2 },
    ]);

    expect(materialize(left.head.root)).toEqual({ doc: "left", count: 2 });
    expect(materialize(right.head.root)).toEqual({ doc: "right", count: 101 });
    expectDeltaApplies(leftSecond.base, leftSecond.outPatch, left.head);
  });

  it("uses delivery order to break ties for conflicting single-key writes", () => {
    const run = (order: Array<"A" | "B">): JsonValue => {
      const record = createSyncRecord({ value: 0 });
      const base = cloneVv(record.vv);

      for (const actor of order) {
        applyIncomingPatch(record, actor, base, [
          { op: "replace", path: "/value", value: actor === "A" ? 1 : 2 },
        ]);
      }

      return materialize(record.head.root);
    };

    expect(run(["A", "B"])).toEqual({ value: 2 });
    expect(run(["B", "A"])).toEqual({ value: 1 });
  });

  it("keeps emitted deltas valid across a mixed delivery sequence", () => {
    const record = createSyncRecord({ count: 0, list: ["a"], meta: { ok: true } });
    const snapshots: VersionVector[] = [cloneVv(record.vv)];

    const events: Array<{
      actor: string;
      baseIndex: number;
      patch: JsonPatchOp[];
      options?: { testAgainst?: "head" | "base"; semantics?: "sequential" | "base" };
    }> = [
      {
        actor: "A",
        baseIndex: 0,
        patch: [{ op: "replace", path: "/count", value: 1 }],
      },
      {
        actor: "B",
        baseIndex: 0,
        patch: [{ op: "add", path: "/list/-", value: "b" }],
      },
      {
        actor: "C",
        baseIndex: 1,
        patch: [{ op: "replace", path: "/meta/ok", value: false }],
      },
      {
        actor: "A",
        baseIndex: 0,
        patch: [{ op: "add", path: "/list/1", value: "fromA" }],
      },
      {
        actor: "B",
        baseIndex: 2,
        patch: [{ op: "replace", path: "/count", value: 5 }],
      },
      {
        actor: "C",
        baseIndex: 0,
        patch: [{ op: "copy", from: "/count", path: "/backup" }],
      },
    ];

    for (const event of events) {
      const baseVv = snapshots[event.baseIndex]!;
      const result = applyIncomingPatch(record, event.actor, baseVv, event.patch, event.options);
      expectDeltaApplies(result.base, result.outPatch, result.head);
      snapshots.push(cloneVv(result.vv));
    }

    const final = materialize(record.head.root) as {
      count: number;
      list: string[];
      meta: { ok: boolean };
      backup: number;
    };

    expect(final.count).toBe(5);
    expect(final.meta.ok).toBe(false);
    expect(final.backup).toBe(0);
    expect(final.list).toContain("a");
    expect(final.list).toContain("b");
    expect(final.list).toContain("fromA");
  });

  it("supports fixed-base array batches from a referenced snapshot", () => {
    const record = createSyncRecord({ list: ["a", "b", "c"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "add", path: "/list/0", value: "x" }]);
    const second = applyIncomingPatch(
      record,
      "B",
      base,
      [
        { op: "remove", path: "/list/1" },
        { op: "replace", path: "/list/2", value: "C" },
      ],
      { semantics: "base" },
    );

    expect(materialize(record.head.root)).toEqual({ list: ["x", "a", "C"] });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("supports sequential batches from a referenced snapshot", () => {
    const record = createSyncRecord({ list: ["a", "b", "c"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "add", path: "/list/0", value: "x" }]);
    const second = applyIncomingPatch(
      record,
      "B",
      base,
      [
        { op: "replace", path: "/list/1", value: "B" },
        { op: "remove", path: "/list/2" },
      ],
      { semantics: "sequential" },
    );

    expect(materialize(record.head.root)).toEqual({ list: ["x", "a", "B"] });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("does not advance state history when a delivery fails", () => {
    const record = createSyncRecord({ list: ["a"] });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "remove", path: "/list/0" }]);
    const beforeVv = cloneVv(record.vv);
    const beforeHistorySize = record.history.size;

    expect(() =>
      applyIncomingPatch(record, "B", base, [{ op: "replace", path: "/list/0", value: "x" }]),
    ).toThrow(PatchError);

    expect(record.vv).toEqual(beforeVv);
    expect(record.history.size).toBe(beforeHistorySize);
  });

  it("copies from referenced snapshots even when sources were removed later", () => {
    const record = createSyncRecord({ obj: { a: 1, b: 2 } });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "remove", path: "/obj/b" }]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "copy", from: "/obj/b", path: "/obj/c" },
    ]);

    expect(materialize(record.head.root)).toEqual({
      obj: {
        a: 1,
        c: 2,
      },
    });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("converges across permutations for disjoint object key updates", () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    const run = (order: number[]): JsonValue => {
      const record = createSyncRecord({ left: 0, right: 0, meta: { ok: true } });
      const base = cloneVv(record.vv);
      const events: Array<{ actor: string; patch: JsonPatchOp[] }> = [
        { actor: "A", patch: [{ op: "replace", path: "/left", value: 1 }] },
        { actor: "B", patch: [{ op: "replace", path: "/right", value: 2 }] },
        { actor: "C", patch: [{ op: "replace", path: "/meta/ok", value: false }] },
      ];

      for (const index of order) {
        const event = events[index]!;
        applyIncomingPatch(record, event.actor, base, event.patch);
      }

      return materialize(record.head.root);
    };

    for (const order of orders) {
      expect(run(order)).toEqual({ left: 1, right: 2, meta: { ok: false } });
    }
  });

  it("converges across permutations for disjoint array index replacements", () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    const run = (order: number[]): JsonValue => {
      const record = createSyncRecord({ list: [0, 1, 2, 3] });
      const base = cloneVv(record.vv);
      const events: Array<{ actor: string; patch: JsonPatchOp[] }> = [
        { actor: "A", patch: [{ op: "replace", path: "/list/0", value: 10 }] },
        { actor: "B", patch: [{ op: "replace", path: "/list/1", value: 11 }] },
        { actor: "C", patch: [{ op: "replace", path: "/list/3", value: 13 }] },
      ];

      for (const index of order) {
        const event = events[index]!;
        applyIncomingPatch(record, event.actor, base, event.patch);
      }

      return materialize(record.head.root);
    };

    for (const order of orders) {
      expect(run(order)).toEqual({ list: [10, 11, 2, 13] });
    }
  });

  it("supports fixed-base assertions in mixed patch batches", () => {
    const record = createSyncRecord({ v: 0 });
    const base = cloneVv(record.vv);

    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/v", value: 1 }]);
    const second = applyIncomingPatch(
      record,
      "B",
      base,
      [
        { op: "test", path: "/v", value: 0 },
        { op: "replace", path: "/v", value: 2 },
      ],
      {
        semantics: "base",
        testAgainst: "base",
      },
    );

    expect(materialize(record.head.root)).toEqual({ v: 2 });
    expectDeltaApplies(second.base, second.outPatch, record.head);
  });

  it("throws when a snapshot lookup is unavailable", () => {
    const record = createSyncRecord({ a: 1 });
    expect(() => snapshotFromRecord(record, { unknown: 99 })).toThrow();
  });

  it("keeps actor counters monotonic across repeated applications from prior snapshots", () => {
    const record = createSyncRecord({ items: [] });
    const base = cloneVv(record.vv);

    const first = applyIncomingPatch(record, "A", base, [
      { op: "add", path: "/items/-", value: "a1" },
    ]);
    const second = applyIncomingPatch(record, "B", base, [
      { op: "add", path: "/items/-", value: "b1" },
    ]);
    const third = applyIncomingPatch(record, "A", base, [
      { op: "add", path: "/items/-", value: "a2" },
    ]);

    expect((third.vv["A"] ?? 0) > (first.vv["A"] ?? 0)).toBeTrue();
    expect(third.vv["B"]).toBe(second.vv["B"]);
    expect((materialize(record.head.root) as { items: string[] }).items.length).toBe(3);
  });

  it("retains all mixed three-writer updates regardless of delivery order", () => {
    const run = (order: number[]): JsonValue => {
      const record = createSyncRecord({ list: ["a"], flag: false });
      const base = cloneVv(record.vv);
      const events: Array<{ actor: string; patch: JsonPatchOp[] }> = [
        { actor: "A", patch: [{ op: "add", path: "/list/-", value: "A" }] },
        { actor: "B", patch: [{ op: "add", path: "/list/-", value: "B" }] },
        { actor: "C", patch: [{ op: "replace", path: "/flag", value: true }] },
      ];

      for (const index of order) {
        const event = events[index]!;
        applyIncomingPatch(record, event.actor, base, event.patch);
      }

      return materialize(record.head.root);
    };

    const first = run([0, 1, 2]) as { list: string[]; flag: boolean };
    const second = run([2, 1, 0]) as { list: string[]; flag: boolean };

    for (const result of [first, second]) {
      expect(result.flag).toBeTrue();
      expect(result.list.length).toBe(3);
      expect(result.list).toContain("a");
      expect(result.list).toContain("A");
      expect(result.list).toContain("B");
    }
  });

  it("replays duplicate append deliveries when envelopes are not deduplicated", () => {
    const record = createSyncRecord({ list: ["a"] });
    const base = cloneVv(record.vv);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/-", value: "dup" }];

    applyIncomingPatch(record, "A", base, patch);
    applyIncomingPatch(record, "A", base, patch);

    const list = (materialize(record.head.root) as { list: string[] }).list;
    expect(list.filter((value) => value === "dup").length).toBe(2);
  });

  it("handles duplicate removals without changing materialized output", () => {
    const record = createSyncRecord({ list: ["a", "b"] });
    const base = cloneVv(record.vv);

    const first = applyIncomingPatch(record, "A", base, [{ op: "remove", path: "/list/1" }]);
    const beforeSecond = materialize(record.head.root);
    const second = applyIncomingPatch(record, "A", base, [{ op: "remove", path: "/list/1" }]);

    expect(materialize(record.head.root)).toEqual(beforeSecond);
    expect((second.vv["A"] ?? 0) > (first.vv["A"] ?? 0)).toBeTrue();
  });

  it("supports envelope-level dedupe for replay safety", () => {
    const record = createSyncRecord({ list: ["a"] });
    const seen = new Set<string>();
    const envelope: SyncEnvelope = {
      id: "event-1",
      actor: "A",
      baseVv: cloneVv(record.vv),
      patch: [{ op: "add", path: "/list/-", value: "x" }],
    };

    const first = applyIncomingWithDedupe(record, seen, envelope);
    const second = applyIncomingWithDedupe(record, seen, envelope);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((materialize(record.head.root) as { list: string[] }).list).toEqual(["a", "x"]);
  });

  it("keeps invariants across long randomized out-of-order deliveries on one document", () => {
    const rng = new SeededRng(4401);
    const record = createSyncRecord({ arr: [0, 1], obj: { a: 1, b: 2 }, flag: false, count: 0 });
    const snapshots: VersionVector[] = [cloneVv(record.vv)];
    const actors = ["A", "B", "C", "D"];

    let success = 0;
    let conflicts = 0;
    for (let i = 0; i < 220; i++) {
      const baseVv = snapshots[rng.int(snapshots.length)]!;
      const baseDoc = snapshotFromRecord(record, baseVv);
      const patch = randomSyncPatchForSnapshot(asSyncJson(materialize(baseDoc.root)), rng);
      const actor = actors[rng.int(actors.length)]!;
      const options = {
        semantics: (rng.bool() ? "sequential" : "base") as "sequential" | "base",
      };

      const beforeHead = materialize(record.head.root);
      const beforeVv = cloneVv(record.vv);
      const beforeHistorySize = record.history.size;

      try {
        const result = applyIncomingPatch(record, actor, baseVv, patch, options);
        expectDeltaApplies(result.base, result.outPatch, result.head);
        snapshots.push(cloneVv(result.vv));
        success++;
      } catch (error) {
        conflicts++;
        expect(error).toBeInstanceOf(PatchError);
        expect(materialize(record.head.root)).toEqual(beforeHead);
        expect(record.vv).toEqual(beforeVv);
        expect(record.history.size).toBe(beforeHistorySize);
      }
    }

    expect(success).toBeGreaterThan(0);
    expect(conflicts).toBeGreaterThan(0);
    const final = asSyncJson(materialize(record.head.root));
    expect(typeof final.count).toBe("number");
    expect(typeof final.flag).toBe("boolean");
  });

  it("keeps cross-document isolation in randomized multi-document streams", () => {
    const rng = new SeededRng(4402);
    const docIds = ["docA", "docB", "docC"] as const;
    const actors = ["A", "B", "C", "D"];
    const records: Record<(typeof docIds)[number], SyncRecord> = {
      docA: createSyncRecord({ arr: [1], obj: { a: 1 }, flag: false, count: 0 }),
      docB: createSyncRecord({ arr: [2], obj: { b: 2 }, flag: true, count: 10 }),
      docC: createSyncRecord({ arr: [3], obj: { c: 3 }, flag: false, count: 20 }),
    };
    const snapshots: Record<(typeof docIds)[number], VersionVector[]> = {
      docA: [cloneVv(records.docA.vv)],
      docB: [cloneVv(records.docB.vv)],
      docC: [cloneVv(records.docC.vv)],
    };

    let success = 0;
    for (let i = 0; i < 240; i++) {
      const targetId = docIds[rng.int(docIds.length)]!;
      const target = records[targetId];
      const targetSnapshots = snapshots[targetId];
      const baseVv = targetSnapshots[rng.int(targetSnapshots.length)]!;
      const baseDoc = snapshotFromRecord(target, baseVv);
      const patch = randomSyncPatchForSnapshot(asSyncJson(materialize(baseDoc.root)), rng);
      const actor = actors[rng.int(actors.length)]!;
      const options = {
        semantics: (rng.bool() ? "sequential" : "base") as "sequential" | "base",
      };

      const beforeTarget = materialize(target.head.root);
      const beforeOthers = new Map<string, JsonValue>();
      for (const docId of docIds) {
        if (docId !== targetId) {
          beforeOthers.set(docId, materialize(records[docId].head.root));
        }
      }

      try {
        const result = applyIncomingPatch(target, actor, baseVv, patch, options);
        expectDeltaApplies(result.base, result.outPatch, result.head);
        targetSnapshots.push(cloneVv(result.vv));
        success++;
      } catch (error) {
        expect(error).toBeInstanceOf(PatchError);
        expect(materialize(target.head.root)).toEqual(beforeTarget);
      }

      for (const docId of docIds) {
        if (docId !== targetId) {
          const before = beforeOthers.get(docId);
          if (before === undefined) {
            throw new Error(`missing pre-state for ${docId}`);
          }
          expect(materialize(records[docId].head.root)).toEqual(before);
        }
      }
    }

    expect(success).toBeGreaterThan(0);
  });

  it("keeps final states identical across different cross-document interleavings", () => {
    const run = (schedule: number[]) => {
      const records = {
        A: createSyncRecord({ arr: [], obj: {}, flag: false, count: 0 }),
        B: createSyncRecord({ arr: [], obj: {}, flag: false, count: 10 }),
        C: createSyncRecord({ arr: [], obj: {}, flag: false, count: 20 }),
      };

      const events: Array<{ doc: "A" | "B" | "C"; actor: string; patch: JsonPatchOp[] }> = [
        { doc: "A", actor: "A1", patch: [{ op: "replace", path: "/count", value: 1 }] },
        { doc: "B", actor: "B1", patch: [{ op: "add", path: "/arr/-", value: "b1" }] },
        { doc: "A", actor: "A2", patch: [{ op: "add", path: "/obj/x", value: 1 }] },
        { doc: "C", actor: "C1", patch: [{ op: "replace", path: "/flag", value: true }] },
        { doc: "B", actor: "B2", patch: [{ op: "replace", path: "/count", value: 99 }] },
        { doc: "A", actor: "A3", patch: [{ op: "replace", path: "/flag", value: true }] },
      ];

      for (const index of schedule) {
        const event = events[index]!;
        const record = records[event.doc];
        const baseVv = cloneVv(record.vv);
        applyIncomingPatch(record, event.actor, baseVv, event.patch);
      }

      return {
        A: materialize(records.A.head.root),
        B: materialize(records.B.head.root),
        C: materialize(records.C.head.root),
      };
    };

    const first = run([0, 1, 2, 3, 4, 5]);
    const second = run([1, 0, 3, 2, 5, 4]);
    expect(first).toEqual(second);
  });

  it("rejects references to pruned snapshots after history compaction", () => {
    const record = createSyncRecord({ count: 0, list: ["a"] });
    const v0 = cloneVv(record.vv);
    const r1 = applyIncomingPatch(record, "A", v0, [{ op: "replace", path: "/count", value: 1 }]);
    const v1 = cloneVv(r1.vv);
    const r2 = applyIncomingPatch(record, "B", v0, [{ op: "add", path: "/list/-", value: "b" }]);
    const v2 = cloneVv(r2.vv);

    compactHistory(record, [v1, v2, cloneVv(record.vv)]);

    expect(() =>
      applyIncomingPatch(record, "C", v0, [{ op: "replace", path: "/count", value: 5 }]),
    ).toThrow();
  });

  it("continues to accept references to retained snapshots after compaction", () => {
    const record = createSyncRecord({ count: 0, list: ["a"] });
    const v0 = cloneVv(record.vv);
    const r1 = applyIncomingPatch(record, "A", v0, [{ op: "replace", path: "/count", value: 1 }]);
    const v1 = cloneVv(r1.vv);
    applyIncomingPatch(record, "B", v0, [{ op: "add", path: "/list/-", value: "b" }]);

    compactHistory(record, [v1, cloneVv(record.vv)]);
    const next = applyIncomingPatch(record, "C", v1, [{ op: "add", path: "/list/-", value: "c" }]);

    expect((materialize(record.head.root) as { list: string[] }).list).toContain("c");
    expectDeltaApplies(next.base, next.outPatch, record.head);
  });

  it("accepts latest-snapshot writes after compacting history to head only", () => {
    const record = createSyncRecord({ count: 0 });
    const v0 = cloneVv(record.vv);
    applyIncomingPatch(record, "A", v0, [{ op: "replace", path: "/count", value: 1 }]);
    const latest = cloneVv(record.vv);

    compactHistory(record, [latest]);
    const next = applyIncomingPatch(record, "B", latest, [
      { op: "replace", path: "/count", value: 2 },
    ]);

    expect(materialize(record.head.root)).toEqual({ count: 2 });
    expectDeltaApplies(next.base, next.outPatch, record.head);
  });

  it("continues correctly after serializing and restoring record state and history", () => {
    const original = createSyncRecord({ arr: [1], obj: { a: 1 }, flag: false, count: 0 });
    const v0 = cloneVv(original.vv);
    const r1 = applyIncomingPatch(original, "A", v0, [{ op: "add", path: "/arr/-", value: 2 }]);
    const v1 = cloneVv(r1.vv);
    applyIncomingPatch(original, "B", v0, [{ op: "replace", path: "/count", value: 10 }]);

    const restored = deserializeSyncRecord(serializeSyncRecord(original));
    const patch: JsonPatchOp[] = [{ op: "add", path: "/obj/fromOld", value: true }];

    const control = applyIncomingPatch(original, "C", v1, patch);
    const resumed = applyIncomingPatch(restored, "C", v1, patch);

    expect(materialize(restored.head.root)).toEqual(materialize(original.head.root));
    expect(restored.vv).toEqual(original.vv);
    expectDeltaApplies(control.base, control.outPatch, original.head);
    expectDeltaApplies(resumed.base, resumed.outPatch, restored.head);
  });

  it("keeps behavior stable after restart when history was compacted", () => {
    const record = createSyncRecord({ count: 0, arr: [], obj: {}, flag: false });
    const v0 = cloneVv(record.vv);
    applyIncomingPatch(record, "A", v0, [{ op: "replace", path: "/count", value: 1 }]);
    const latest = cloneVv(record.vv);

    compactHistory(record, [latest]);
    const restored = deserializeSyncRecord(serializeSyncRecord(record));

    expect(() =>
      applyIncomingPatch(restored, "B", v0, [{ op: "replace", path: "/count", value: 2 }]),
    ).toThrow();

    const next = applyIncomingPatch(restored, "B", latest, [
      { op: "replace", path: "/count", value: 3 },
    ]);
    expect(materialize(restored.head.root)).toEqual({ count: 3, arr: [], obj: {}, flag: false });
    expectDeltaApplies(next.base, next.outPatch, restored.head);
  });

  it("produces equivalent outcomes for original and restored multi-document sessions", () => {
    const createRecords = () => ({
      left: createSyncRecord({ arr: [1], obj: { a: 1 }, flag: false, count: 0 }),
      right: createSyncRecord({ arr: [2], obj: { b: 2 }, flag: true, count: 10 }),
    });

    const original = createRecords();
    const vLeft0 = cloneVv(original.left.vv);
    const vRight0 = cloneVv(original.right.vv);

    applyIncomingPatch(original.left, "A", vLeft0, [{ op: "add", path: "/arr/-", value: 3 }]);
    applyIncomingPatch(original.right, "B", vRight0, [
      { op: "replace", path: "/count", value: 11 },
    ]);

    const restored = {
      left: deserializeSyncRecord(serializeSyncRecord(original.left)),
      right: deserializeSyncRecord(serializeSyncRecord(original.right)),
    };

    const followUp = [
      {
        doc: "left" as const,
        actor: "C",
        base: cloneVv(vLeft0),
        patch: [{ op: "add", path: "/obj/x", value: "x" }] as JsonPatchOp[],
      },
      {
        doc: "right" as const,
        actor: "D",
        base: cloneVv(vRight0),
        patch: [{ op: "add", path: "/arr/0", value: 0 }] as JsonPatchOp[],
      },
      {
        doc: "left" as const,
        actor: "E",
        base: cloneVv(original.left.vv),
        patch: [{ op: "replace", path: "/flag", value: true }] as JsonPatchOp[],
      },
      {
        doc: "right" as const,
        actor: "F",
        base: cloneVv(original.right.vv),
        patch: [{ op: "add", path: "/obj/c", value: 3 }] as JsonPatchOp[],
      },
    ];

    for (const event of followUp) {
      applyIncomingPatch(original[event.doc], event.actor, event.base, event.patch);
      applyIncomingPatch(restored[event.doc], event.actor, event.base, event.patch);
    }

    expect(materialize(restored.left.head.root)).toEqual(materialize(original.left.head.root));
    expect(materialize(restored.right.head.root)).toEqual(materialize(original.right.head.root));
    expect(restored.left.vv).toEqual(original.left.vv);
    expect(restored.right.vv).toEqual(original.right.vv);
  });

  it("preserves testAgainst behavior across restarts", () => {
    const record = createSyncRecord({ v: 1 });
    const base = cloneVv(record.vv);
    applyIncomingPatch(record, "A", base, [{ op: "replace", path: "/v", value: 2 }]);

    const restored = deserializeSyncRecord(serializeSyncRecord(record));
    expect(() =>
      applyIncomingPatch(restored, "B", base, [
        { op: "test", path: "/v", value: 1 },
        { op: "replace", path: "/v", value: 3 },
      ]),
    ).toThrow(PatchError);

    const next = applyIncomingPatch(
      restored,
      "B",
      base,
      [
        { op: "test", path: "/v", value: 1 },
        { op: "replace", path: "/v", value: 3 },
      ],
      { testAgainst: "base" },
    );

    expect(materialize(restored.head.root)).toEqual({ v: 3 });
    expectDeltaApplies(next.base, next.outPatch, restored.head);
  });

  it("handles randomized streams with periodic compaction and restart", () => {
    const rng = new SeededRng(4403);
    let record = createSyncRecord({ arr: [0], obj: { a: 1 }, flag: false, count: 0 });
    const actors = ["A", "B", "C", "D", "E"];
    const knownSnapshots: VersionVector[] = [cloneVv(record.vv)];

    let success = 0;
    let conflicts = 0;
    for (let i = 0; i < 180; i++) {
      if (i > 0 && i % 24 === 0) {
        const available = knownSnapshots.filter((vv) => record.history.has(versionKey(vv)));
        const keep: VersionVector[] = [cloneVv(record.vv)];
        if (available.length > 0) {
          keep.push(cloneVv(available[rng.int(available.length)]!));
        }
        if (available.length > 1) {
          keep.push(cloneVv(available[rng.int(available.length)]!));
        }

        compactHistory(record, keep);
        record = deserializeSyncRecord(serializeSyncRecord(record));
      }

      const available = knownSnapshots.filter((vv) => record.history.has(versionKey(vv)));
      const baseVv = cloneVv(available[rng.int(available.length)]!);
      const baseDoc = snapshotFromRecord(record, baseVv);
      const patch = randomSyncPatchForSnapshot(asSyncJson(materialize(baseDoc.root)), rng);
      const actor = actors[rng.int(actors.length)]!;
      const options = {
        semantics: (rng.bool() ? "sequential" : "base") as "sequential" | "base",
      };

      const beforeHead = materialize(record.head.root);
      const beforeVv = cloneVv(record.vv);
      const beforeHistorySize = record.history.size;

      try {
        const result = applyIncomingPatch(record, actor, baseVv, patch, options);
        expectDeltaApplies(result.base, result.outPatch, result.head);
        knownSnapshots.push(cloneVv(result.vv));
        success++;
      } catch (error) {
        conflicts++;
        expect(error).toBeInstanceOf(PatchError);
        expect(materialize(record.head.root)).toEqual(beforeHead);
        expect(record.vv).toEqual(beforeVv);
        expect(record.history.size).toBe(beforeHistorySize);
      }
    }

    expect(success).toBeGreaterThan(0);
    expect(conflicts).toBeGreaterThan(0);
  });

  it("supports persisted dedupe ledgers across restarts", () => {
    const record = createSyncRecord({ list: ["a"] });
    const seen = new Set<string>();
    const envelope: SyncEnvelope = {
      id: "evt-1",
      actor: "A",
      baseVv: cloneVv(record.vv),
      patch: [{ op: "add", path: "/list/-", value: "x" }],
    };

    applyIncomingWithDedupe(record, seen, envelope);
    const restored = deserializeSyncRecord(serializeSyncRecord(record));
    const replayed = applyIncomingWithDedupe(restored, seen, envelope);

    expect(replayed).toBeNull();
    expect((materialize(restored.head.root) as { list: string[] }).list).toEqual(["a", "x"]);
  });
});
