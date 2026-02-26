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

describe("mergeDoc", () => {
  it("merges two identical documents", () => {
    const a = docFromJson({ x: 1 }, newDotGen("A"));
    const b = docFromJson({ x: 1 }, newDotGen("B"));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({ x: 1 });
  });

  it("merges LWW registers by highest dot", () => {
    const a = docFromJson(1, () => dot("A", 1));
    const b = docFromJson(2, () => dot("A", 2));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toBe(2);
  });

  it("merges LWW registers with actor tie-breaking", () => {
    const a = docFromJson(1, () => dot("A", 1));
    const b = docFromJson(2, () => dot("B", 1));
    const merged = mergeDoc(a, b);
    // B > A lexicographically at same counter
    expect(materialize(merged.root)).toBe(2);
  });

  it("merges objects with disjoint keys", () => {
    const a = docFromJson({ a: 1 }, newDotGen("A"));
    const b = docFromJson({ b: 2 }, newDotGen("B"));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({ a: 1, b: 2 });
  });

  it("merges objects with overlapping keys using LWW on entries", () => {
    const a = docFromJson({ x: 1 }, () => dot("A", 1));
    const b = docFromJson({ x: 2 }, () => dot("A", 2));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({ x: 2 });
  });

  it("respects delete-wins for object keys", () => {
    const a = docFromJson({ x: 1, y: 2 }, newDotGen("A"));
    // Simulate: B has deleted key "x" with a dot higher than A's entry dot
    const b = docFromJson({ y: 2 }, newDotGen("B"));
    // Manually add a tombstone for "x" with a high dot
    if (b.root.kind === "obj") {
      b.root.tombstone.set("x", dot("B", 100));
    }
    const merged = mergeDoc(a, b);
    const result = materialize(merged.root);
    expect(result).toEqual({ y: 2 });
  });

  it("resurrects a key when entry dot > tombstone dot", () => {
    const a = docFromJson({ x: 1 }, () => dot("A", 10));
    const b = docFromJson({}, newDotGen("B"));
    if (b.root.kind === "obj") {
      b.root.tombstone.set("x", dot("B", 5));
    }
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({ x: 1 });
  });

  it("merges RGA arrays from two peers", () => {
    // Both peers start from the SAME document (shared origin)
    const origin = createState({ list: ["a", "b"] }, { actor: "origin" });
    const stateA: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("A", origin.clock.ctr),
    };
    const stateB: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("B", origin.clock.ctr),
    };

    // A appends "c"
    const nextA = applyPatch(stateA, [{ op: "add", path: "/list/-", value: "c" }]);
    // B appends "d"
    const nextB = applyPatch(stateB, [{ op: "add", path: "/list/-", value: "d" }]);

    const merged = mergeDoc(nextA.doc, nextB.doc);
    const result = materialize(merged.root) as { list: string[] };
    // Both "c" and "d" should be present alongside the originals
    expect(result.list).toContain("a");
    expect(result.list).toContain("b");
    expect(result.list).toContain("c");
    expect(result.list).toContain("d");
    expect(result.list.length).toBe(4);
  });

  it("merges RGA with concurrent inserts at same position", () => {
    const origin = createState({ list: ["a"] }, { actor: "origin" });
    const stateA: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("A", origin.clock.ctr),
    };
    const stateB: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("B", origin.clock.ctr),
    };

    // Both insert after "a"
    const nextA = applyPatch(stateA, [{ op: "add", path: "/list/1", value: "fromA" }]);
    const nextB = applyPatch(stateB, [{ op: "add", path: "/list/1", value: "fromB" }]);

    const merged = mergeDoc(nextA.doc, nextB.doc);
    const result = materialize(merged.root) as { list: string[] };
    expect(result.list).toContain("a");
    expect(result.list).toContain("fromA");
    expect(result.list).toContain("fromB");
    expect(result.list.length).toBe(3);
  });

  it("merges RGA with tombstones (delete wins)", () => {
    const origin = createState({ list: ["a", "b", "c"] }, { actor: "origin" });
    const stateA: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("A", origin.clock.ctr),
    };
    const stateB: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("B", origin.clock.ctr),
    };

    // A deletes "b"
    const nextA = applyPatch(stateA, [{ op: "remove", path: "/list/1" }]);

    const merged = mergeDoc(nextA.doc, stateB.doc);
    const result = materialize(merged.root) as { list: string[] };
    // Tombstone from A should win
    expect(result.list).toEqual(["a", "c"]);
  });

  it("merges deeply nested structures recursively", () => {
    const a = docFromJson({ obj: { nested: { x: 1 } } }, newDotGen("A"));
    const b = docFromJson({ obj: { nested: { x: 2 } } }, newDotGen("B"));
    const merged = mergeDoc(a, b);
    const result = materialize(merged.root) as any;
    // B has higher dots (B:1 > A:1 lexicographically at same counter)
    expect(result.obj.nested.x).toBe(2);
  });

  it("handles kind mismatch by picking higher representative dot", () => {
    // A has a primitive, B has an object — at the root level
    const a = docFromJson(42, () => dot("A", 1));
    const b = docFromJson({ key: "val" }, () => dot("A", 5));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({ key: "val" });
  });

  it("handles kind mismatch where primitive has higher dot", () => {
    const a = docFromJson(42, () => dot("A", 10));
    const b = docFromJson({ key: "val" }, () => dot("A", 1));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toBe(42);
  });

  it("merges empty objects", () => {
    const a = docFromJson({}, newDotGen("A"));
    const b = docFromJson({}, newDotGen("B"));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual({});
  });

  it("merges empty arrays", () => {
    const a = docFromJson([], newDotGen("A"));
    const b = docFromJson([], newDotGen("B"));
    const merged = mergeDoc(a, b);
    expect(materialize(merged.root)).toEqual([]);
  });

  it("rejects merging unrelated non-empty arrays by default", () => {
    const a = docFromJson([1], newDotGen("A"));
    const b = docFromJson([1], newDotGen("B"));
    expect(() => mergeDoc(a, b)).toThrow();
  });

  it("exposes non-throwing mergeDoc errors with typed reasons", () => {
    const a = docFromJson([1], newDotGen("A"));
    const b = docFromJson([1], newDotGen("B"));
    const res = tryMergeDoc(a, b);
    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.error.reason).toBe("LINEAGE_MISMATCH");
      expect(res.error.code).toBe(409);
    }
  });

  it("allows merging unrelated arrays when shared-origin checks are disabled", () => {
    const a = docFromJson([1], newDotGen("A"));
    const b = docFromJson([1], newDotGen("B"));
    const merged = mergeDoc(a, b, { requireSharedOrigin: false });
    expect(materialize(merged.root)).toEqual([1, 1]);
  });

  it("rejects shared RGA ids when predecessor metadata disagrees", () => {
    const origin = createState({ list: ["a", "b"] }, { actor: "origin" });
    const a = cloneDoc(origin.doc);
    const b = cloneDoc(origin.doc);

    if (a.root.kind !== "obj" || b.root.kind !== "obj") {
      throw new Error("Expected object roots");
    }
    const seqA = a.root.entries.get("list")?.node;
    const seqB = b.root.entries.get("list")?.node;
    if (!seqA || !seqB || seqA.kind !== "seq" || seqB.kind !== "seq") {
      throw new Error("Expected list sequences");
    }

    const ids = rgaLinearizeIds(seqA);
    const secondId = ids[1];
    if (!secondId) {
      throw new Error("Expected second element id");
    }

    const corrupted = seqB.elems.get(secondId);
    if (!corrupted) {
      throw new Error("Expected shared element in second sequence");
    }
    corrupted.prev = HEAD;

    const res = tryMergeDoc(a, b);
    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.error.reason).toBe("LINEAGE_MISMATCH");
      expect(res.error.path).toBe("/list");
      expect(res.error.message).toContain("prev");
      expect(res.error.message).toContain(secondId);
    }

    expect(() => mergeDoc(a, b)).toThrow(MergeError);
  });

  it("rejects shared RGA ids when insertion dots disagree", () => {
    const origin = createState({ list: ["a", "b"] }, { actor: "origin" });
    const a = cloneDoc(origin.doc);
    const b = cloneDoc(origin.doc);

    if (a.root.kind !== "obj" || b.root.kind !== "obj") {
      throw new Error("Expected object roots");
    }
    const seqA = a.root.entries.get("list")?.node;
    const seqB = b.root.entries.get("list")?.node;
    if (!seqA || !seqB || seqA.kind !== "seq" || seqB.kind !== "seq") {
      throw new Error("Expected list sequences");
    }

    const ids = rgaLinearizeIds(seqA);
    const secondId = ids[1];
    if (!secondId) {
      throw new Error("Expected second element id");
    }

    const corrupted = seqB.elems.get(secondId);
    if (!corrupted) {
      throw new Error("Expected shared element in second sequence");
    }
    corrupted.insDot = { ...corrupted.insDot, ctr: corrupted.insDot.ctr + 1 };

    const res = tryMergeDoc(a, b);
    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.error.reason).toBe("LINEAGE_MISMATCH");
      expect(res.error.path).toBe("/list");
      expect(res.error.message).toContain("insDot");
      expect(res.error.message).toContain(secondId);
    }

    expect(() => mergeDoc(a, b)).toThrow(MergeError);
  });

  it("is commutative: merge(a,b) equals merge(b,a)", () => {
    const a = docFromJson({ x: 1, y: 2 }, newDotGen("A"));
    const b = docFromJson({ x: 3, z: 4 }, newDotGen("B"));
    const ab = mergeDoc(a, b);
    const ba = mergeDoc(b, a);
    expect(materialize(ab.root)).toEqual(materialize(ba.root));
  });

  it("is idempotent: merge(a,a) equals a", () => {
    const a = docFromJson({ x: [1, 2], y: { z: true } }, newDotGen("A"));
    const merged = mergeDoc(a, a);
    expect(materialize(merged.root)).toEqual(materialize(a.root));
  });
});

describe("mergeState", () => {
  it("merges two states and keeps the local actor by default", () => {
    const a = createState({ x: 1 }, { actor: "A" });
    const b = createState({ y: 2 }, { actor: "B" });

    // Advance A's clock further (applyPatch is immutable, use the result)
    const a1 = applyPatch(a, [{ op: "replace", path: "/x", value: 10 }]);
    const a2 = applyPatch(a1, [{ op: "replace", path: "/x", value: 20 }]);

    const merged = mergeState(a2, b);
    expect(merged.clock.actor).toBe("A");
    expect(merged.clock.ctr).toBeGreaterThanOrEqual(a2.clock.ctr);
  });

  it("allows explicitly selecting the merged actor", () => {
    const a = createState({ x: 1 }, { actor: "A" });
    const b = createState({ y: 2 }, { actor: "B" });
    const merged = mergeState(a, b, { actor: "B" });
    expect(merged.clock.actor).toBe("B");
  });

  it("exposes non-throwing mergeState errors with typed reasons", () => {
    const a = createState([1], { actor: "A" });
    const b = createState([1], { actor: "B" });
    const res = tryMergeState(a, b);
    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.error.reason).toBe("LINEAGE_MISMATCH");
    }
  });

  it("merges deeply nested object states without stack overflow", () => {
    const depth = 8_000;
    const a = createState(makeDeepObject(depth, 1), { actor: "A" });
    const b = createState(makeDeepObject(depth, 2), { actor: "B" });
    const merged = mergeState(a, b);
    const result = toJson(merged);
    expect(readDeepObjectLeaf(result, depth)).toBe(2);
  });

  it("returns typed depth errors for unsupported merge depth", () => {
    const a: CrdtState = {
      doc: { root: makeDeepObjectNode(MAX_TRAVERSAL_DEPTH + 1, 1, "A") },
      clock: createClock("A", 0),
    };
    const b: CrdtState = {
      doc: { root: makeDeepObjectNode(MAX_TRAVERSAL_DEPTH + 1, 2, "B") },
      clock: createClock("B", 0),
    };

    const nonThrowing = tryMergeState(a, b);
    expect(nonThrowing.ok).toBeFalse();
    if (!nonThrowing.ok) {
      expect(nonThrowing.error.reason).toBe("MAX_DEPTH_EXCEEDED");
    }

    expect(() => mergeState(a, b)).toThrow(MergeError);
    try {
      mergeState(a, b);
    } catch (error) {
      expect(error).toBeInstanceOf(MergeError);
      if (error instanceof MergeError) {
        expect(error.reason).toBe("MAX_DEPTH_EXCEEDED");
      }
    }
  });

  it("produces a state that can continue accepting patches", () => {
    const a = createState({ val: 1 }, { actor: "A" });
    const b = createState({ val: 2 }, { actor: "B" });

    const merged = mergeState(a, b);
    const next = applyPatch(merged, [{ op: "replace", path: "/val", value: 99 }]);
    expect(toJson(next)).toEqual({ val: 99 });
  });

  it("merged state serializes and deserializes correctly", () => {
    const a = createState({ a: 1 }, { actor: "A" });
    const b = createState({ b: 2 }, { actor: "B" });
    const merged = mergeState(a, b);

    const payload = serializeState(merged);
    const restored = deserializeState(payload);
    expect(toJson(restored)).toEqual(toJson(merged));
  });

  it("full workflow: diverge, merge, converge", () => {
    const initial = { count: 0, items: ["a"] };
    const origin = createState(initial, { actor: "origin" });
    const stateA: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("A", origin.clock.ctr),
    };
    const stateB: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("B", origin.clock.ctr),
    };

    // A increments count and appends
    const a1 = applyPatch(stateA, [
      { op: "replace", path: "/count", value: 1 },
      { op: "add", path: "/items/-", value: "b" },
    ]);

    // B increments count differently and appends
    const b1 = applyPatch(stateB, [
      { op: "replace", path: "/count", value: 2 },
      { op: "add", path: "/items/-", value: "c" },
    ]);

    const merged = mergeState(a1, b1);
    const result = toJson(merged) as { count: number; items: string[] };

    // Both items should be present
    expect(result.items).toContain("a");
    expect(result.items).toContain("b");
    expect(result.items).toContain("c");
    expect(result.items.length).toBe(3);
    // count: one of the two values wins via LWW
    expect([1, 2]).toContain(result.count);
  });

  it("preserves concurrent post-merge edits when peers keep distinct actors", () => {
    const origin = createState({ items: ["a"] }, { actor: "origin" });
    const peerA: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("A", origin.clock.ctr),
    };
    const peerB: CrdtState = {
      doc: cloneDoc(origin.doc),
      clock: createClock("B", origin.clock.ctr),
    };

    const a1 = applyPatch(peerA, [{ op: "add", path: "/items/-", value: "fromA1" }]);
    const b1 = applyPatch(peerB, [{ op: "add", path: "/items/-", value: "fromB1" }]);

    // Each peer merges with its own actor identity.
    const aMerged = mergeState(a1, b1, { actor: "A" });
    const bMerged = mergeState(b1, a1, { actor: "B" });

    const a2 = applyPatch(aMerged, [{ op: "add", path: "/items/-", value: "fromA2" }]);
    const b2 = applyPatch(bMerged, [{ op: "add", path: "/items/-", value: "fromB2" }]);

    const merged = mergeState(a2, b2, { actor: "A" });
    const result = toJson(merged) as { items: string[] };
    expect(result.items.length).toBe(5);
    expect(result.items).toContain("a");
    expect(result.items).toContain("fromA1");
    expect(result.items).toContain("fromB1");
    expect(result.items).toContain("fromA2");
    expect(result.items).toContain("fromB2");
  });
});

describe("tombstone compaction", () => {
  it("compacts causally-stable object tombstones without changing materialized output", () => {
    const state = createState({ obj: { x: 1 } }, { actor: "A" });
    const removed = applyPatch(state, [{ op: "remove", path: "/obj/x" }]);
    const beforeJson = toJson(removed);

    const beforeObjNode = (removed.doc.root as any).entries.get("obj")?.node as any;
    expect(beforeObjNode.tombstone.has("x")).toBeTrue();

    const compacted = compactStateTombstones(removed, {
      stable: { A: removed.clock.ctr },
    });
    const afterObjNode = (compacted.state.doc.root as any).entries.get("obj")?.node as any;

    expect(compacted.stats.objectTombstonesRemoved).toBe(1);
    expect(toJson(compacted.state)).toEqual(beforeJson);
    expect(afterObjNode.tombstone.has("x")).toBeFalse();
    // Immutable by default: original state remains unchanged.
    expect(beforeObjNode.tombstone.has("x")).toBeTrue();
  });

  it("keeps object tombstones when they are not causally stable", () => {
    const state = createState({ obj: { x: 1 } }, { actor: "A" });
    const removed = applyPatch(state, [{ op: "remove", path: "/obj/x" }]);

    const compacted = compactStateTombstones(removed, {
      stable: { A: Math.max(0, removed.clock.ctr - 1) },
    });
    const afterObjNode = (compacted.state.doc.root as any).entries.get("obj")?.node as any;

    expect(compacted.stats.objectTombstonesRemoved).toBe(0);
    expect(afterObjNode.tombstone.has("x")).toBeTrue();
  });

  it("compacts stable tombstoned sequence elements when no live descendants depend on them", () => {
    const state = createState(["a", "b", "c"], { actor: "A" });
    const removed = applyPatch(state, [{ op: "remove", path: "/2" }], {
      semantics: "sequential",
    });
    const beforeJson = toJson(removed);

    const compacted = compactStateTombstones(removed, {
      stable: { A: removed.clock.ctr },
    });

    expect(compacted.stats.sequenceTombstonesRemoved).toBeGreaterThanOrEqual(1);
    expect(toJson(compacted.state)).toEqual(beforeJson);
  });

  it("keeps tombstoned sequence anchors that still have live descendants", () => {
    const state = createState(["a"], { actor: "A" });
    const withChild = applyPatch(state, [{ op: "add", path: "/1", value: "b" }], {
      semantics: "sequential",
    });
    const deletedAnchor = applyPatch(withChild, [{ op: "remove", path: "/0" }], {
      semantics: "sequential",
    });

    const compacted = compactStateTombstones(deletedAnchor, {
      stable: { A: deletedAnchor.clock.ctr },
    });

    expect(toJson(compacted.state)).toEqual(["b"]);
    expect(compacted.stats.sequenceTombstonesRemoved).toBe(0);
  });

  it("does not compact sequence deletes before the delete event is causally stable", () => {
    const origin = createState(["x"], { actor: "origin" });
    const replicaA = forkState(origin, "A");
    const replicaB = forkState(origin, "B");

    const deletedOnA = applyPatch(replicaA, [{ op: "remove", path: "/0" }], {
      semantics: "sequential",
    });
    expect(toJson(deletedOnA)).toEqual([]);

    const compactedA = compactStateTombstones(deletedOnA, {
      stable: {
        origin: origin.clock.ctr,
        A: replicaA.clock.ctr,
      },
    });

    expect(toJson(compactedA.state)).toEqual([]);
    expect(compactedA.stats.sequenceTombstonesRemoved).toBe(0);

    const merged = mergeState(compactedA.state, replicaB, { actor: "A" });
    expect(toJson(merged)).toEqual([]);
  });

  it("supports in-place document compaction for server workflows", () => {
    const state = createState({ obj: { x: 1 } }, { actor: "A" });
    const removed = applyPatch(state, [{ op: "remove", path: "/obj/x" }]);

    const compacted = compactDocTombstones(removed.doc, {
      stable: { A: removed.clock.ctr },
      mutate: true,
    });

    const objNode = (removed.doc.root as any).entries.get("obj")?.node as any;
    expect(compacted.stats.objectTombstonesRemoved).toBe(1);
    expect(objNode.tombstone.has("x")).toBeFalse();
    expect(materialize(removed.doc.root)).toEqual({ obj: {} });
  });
});
