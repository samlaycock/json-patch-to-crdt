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

describe("dots and version vectors", () => {
  it("compares dots by counter then actor", () => {
    expect(compareDot(dot("A", 1), dot("A", 2))).toBeLessThan(0);
    expect(compareDot(dot("A", 2), dot("A", 1))).toBeGreaterThan(0);
    expect(compareDot(dot("A", 1), dot("B", 1))).toBeLessThan(0);
    expect(compareDot(dot("B", 1), dot("A", 1))).toBeGreaterThan(0);
  });

  it("merges version vectors by max", () => {
    const a: VersionVector = { A: 1, B: 3 };
    const b: VersionVector = { A: 2, C: 4 };
    expect(vvMerge(a, b)).toEqual({ A: 2, B: 3, C: 4 });
  });

  it("checks version vector has dot", () => {
    const vv: VersionVector = { A: 3 };
    expect(vvHasDot(vv, dot("A", 2))).toBeTrue();
    expect(vvHasDot(vv, dot("A", 4))).toBeFalse();
    expect(vvHasDot(vv, dot("B", 1))).toBeFalse();
  });
});

describe("clock and state", () => {
  it("creates clocks that increment per dot", () => {
    const clock = createClock("A");
    expect(clock.ctr).toBe(0);
    expect(clock.next()).toEqual({ actor: "A", ctr: 1 });
    expect(clock.ctr).toBe(1);
    expect(clock.next()).toEqual({ actor: "A", ctr: 2 });
    expect(clock.ctr).toBe(2);
  });

  it("clones clocks independently", () => {
    const clock = createClock("A", 5);
    const clone = cloneClock(clock);

    expect(clone.next()).toEqual({ actor: "A", ctr: 6 });
    expect(clock.ctr).toBe(5);
  });

  it("supports per-actor dot generation from version vectors", () => {
    const vv: VersionVector = {};
    expect(nextDotForActor(vv, "A")).toEqual({ actor: "A", ctr: 1 });
    expect(nextDotForActor(vv, "B")).toEqual({ actor: "B", ctr: 1 });
    observeDot(vv, { actor: "A", ctr: 5 });
    expect(nextDotForActor(vv, "A")).toEqual({ actor: "A", ctr: 6 });
  });

  it("creates state and materializes JSON", () => {
    const state = createState(1, { actor: "A" });
    expect(toJson(state)).toBe(1);
    expect(state.clock.ctr).toBe(1);
  });

  it("handles deeply nested objects in createState and toJson", () => {
    const depth = 8_000;
    const deepValue = makeDeepObject(depth, "leaf");
    const state = createState(deepValue, { actor: "A" });
    const result = toJson(state);
    expect(readDeepObjectLeaf(result, depth)).toBe("leaf");
  });

  it("throws a typed depth error for unsupported createState nesting", () => {
    const tooDeep = makeDeepObject(MAX_TRAVERSAL_DEPTH + 1, "leaf");
    expect(() => createState(tooDeep, { actor: "A" })).toThrow(TraversalDepthError);
  });

  it("forks shared-origin replicas with independent actors", () => {
    const origin = createState({ list: ["a"] }, { actor: "origin" });
    const peerA = forkState(origin, "A");
    const peerB = forkState(origin, "B");

    const a1 = applyPatch(peerA, [{ op: "add", path: "/list/-", value: "fromA" }]);
    const b1 = applyPatch(peerB, [{ op: "add", path: "/list/-", value: "fromB" }]);

    const merged = mergeState(a1, b1, { actor: "A" });
    const list = (toJson(merged) as { list: string[] }).list;
    expect(list).toContain("a");
    expect(list).toContain("fromA");
    expect(list).toContain("fromB");
  });

  it("rejects same-actor fork reuse by default", () => {
    const origin = createState({ count: 0 }, { actor: "A" });
    expect(() => forkState(origin, "A")).toThrow(
      "forkState actor must be unique; refusing to reuse origin actor 'A'",
    );
  });

  it("allows same-actor fork reuse only when explicitly enabled", () => {
    const origin = createState({ count: 0 }, { actor: "A" });
    const reused = forkState(origin, "A", { allowActorReuse: true });
    expect(toJson(reused)).toEqual({ count: 0 });
    expect(reused.clock.actor).toBe("A");
    expect(reused.clock.ctr).toBe(origin.clock.ctr);
  });

  it("applies patches with the friendly API", () => {
    const state = createState({ list: ["a"] }, { actor: "A" });
    const next = applyPatch(state, [{ op: "add", path: "/list/-", value: "b" }]);
    expect(toJson(state)).toEqual({ list: ["a"] });
    expect(toJson(next)).toEqual({ list: ["a", "b"] });
  });

  it("applies patches over deeply nested state without overflowing", () => {
    const depth = 8_000;
    const state = createState(makeDeepObject(depth, "base"), { actor: "A" });
    const next = applyPatch(state, [{ op: "add", path: "/status", value: "ok" }]);
    const result = toJson(next) as Record<string, JsonValue>;
    expect(result.status).toBe("ok");
    expect(readDeepObjectLeaf(result, depth)).toBe("base");
  });

  it("returns typed depth errors when patch values exceed max depth", () => {
    const state = createState({}, { actor: "A" });
    const patch = [
      { op: "add", path: "/value", value: makeDeepObject(MAX_TRAVERSAL_DEPTH + 1, 1) },
    ] as const;

    const nonThrowing = tryApplyPatch(state, patch as unknown as JsonPatchOp[]);
    expect(nonThrowing.ok).toBeFalse();
    if (!nonThrowing.ok) {
      expect(nonThrowing.error.reason).toBe("MAX_DEPTH_EXCEEDED");
    }

    expect(() => applyPatch(state, patch as unknown as JsonPatchOp[])).toThrow(PatchError);
    try {
      applyPatch(state, patch as unknown as JsonPatchOp[]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      if (error instanceof PatchError) {
        expect(error.reason).toBe("MAX_DEPTH_EXCEEDED");
      }
    }
  });

  it("throws PatchError when a patch fails", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    try {
      applyPatch(state, [{ op: "test", path: "/a", value: 2 }]);
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      if (err instanceof PatchError) {
        expect(err.code).toBe(409);
      }
      return;
    }
    throw new Error("Expected PatchError");
  });

  it("throws PatchError when object parents are missing", () => {
    const state = createState({}, { actor: "A" });
    expect(() => applyPatch(state, [{ op: "add", path: "/missing/key", value: 1 }])).toThrow(
      PatchError,
    );
  });

  it("rejects __proto__ paths without polluting Object.prototype", () => {
    const state = createState({}, { actor: "A" });
    const marker = "__json_patch_to_crdt_prototype_pollution_marker__";
    const prototypeRecord = Object.prototype as Record<string, unknown>;

    delete prototypeRecord[marker];

    try {
      expect(({} as Record<string, unknown>)[marker]).toBeUndefined();
      expect(() =>
        applyPatch(state, [{ op: "add", path: `/__proto__/${marker}`, value: true }]),
      ).toThrow(PatchError);
      expect(({} as Record<string, unknown>)[marker]).toBeUndefined();
    } finally {
      delete prototypeRecord[marker];
    }
  });

  it("supports immutable patch application", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const next = applyPatch(state, [{ op: "replace", path: "/a", value: 2 }]);

    expect(toJson(state)).toEqual({ a: 1 });
    expect(toJson(next)).toEqual({ a: 2 });
    expect(next.clock.ctr).toBeGreaterThanOrEqual(state.clock.ctr);
  });

  it("does not mutate state when immutable patch fails", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    expect(() => applyPatch(state, [{ op: "test", path: "/a", value: 2 }])).toThrow(PatchError);
    expect(toJson(state)).toEqual({ a: 1 });
  });

  it("supports test operations against an explicit base state", () => {
    const base = createState({ a: 1 }, { actor: "A" });
    const head = createState({ a: 2 }, { actor: "A" });
    const next = applyPatch(head, [{ op: "test", path: "/a", value: 1 }], {
      base,
      testAgainst: "base",
    });
    expect(toJson(next)).toEqual({ a: 2 });
  });

  it("supports test operations against head when base differs", () => {
    const base = createState({ a: 1 }, { actor: "A" });
    const head = createState({ a: 2 }, { actor: "A" });
    const next = applyPatch(head, [{ op: "test", path: "/a", value: 2 }], {
      base,
      testAgainst: "head",
    });
    expect(toJson(next)).toEqual({ a: 2 });
  });

  it("maps array indices using base snapshot, not head", () => {
    const base = createState({ list: ["a", "b"] }, { actor: "A" });
    const head = createState({ list: ["a", "b"] }, { actor: "A" });

    const headWithInsert = applyPatch(head, [{ op: "add", path: "/list/1", value: "x" }]);

    const headWithReplace = applyPatch(
      headWithInsert,
      [{ op: "replace", path: "/list/1", value: "B" }],
      {
        base,
      },
    );

    expect(toJson(headWithReplace)).toEqual({ list: ["a", "x", "B"] });
  });

  it("supports sequential patch semantics against the evolving head", () => {
    const state = createState({ list: [1, 2] }, { actor: "A" });
    const next = applyPatch(state, [{ op: "add", path: "/list/0", value: 99 }], {
      semantics: "sequential",
    });
    expect(toJson(next)).toEqual({ list: [99, 1, 2] });
  });

  it("supports multi-op sequential array edits against the evolving head", () => {
    const state = createState({ list: [1, 2, 3] }, { actor: "A" });
    const next = applyPatch(
      state,
      [
        { op: "add", path: "/list/1", value: 9 },
        { op: "replace", path: "/list/1", value: 42 },
        { op: "remove", path: "/list/0" },
      ],
      {
        semantics: "sequential",
      },
    );

    expect(toJson(next)).toEqual({ list: [42, 2, 3] });
  });

  it("keeps sequential testAgainst base aligned with the evolving head when no explicit base", () => {
    const state = createState({ list: [1] }, { actor: "A" });
    const next = applyPatch(
      state,
      [
        { op: "add", path: "/list/-", value: 2 },
        { op: "test", path: "/list/1", value: 2 },
        { op: "replace", path: "/list/1", value: 3 },
      ],
      {
        semantics: "sequential",
        testAgainst: "base",
      },
    );

    expect(toJson(next)).toEqual({ list: [1, 3] });
  });

  it("supports sequential move semantics for arrays", () => {
    const state = createState(["a", "b", "c"], { actor: "A" });
    const next = applyPatch(state, [{ op: "move", from: "/2", path: "/0" }], {
      semantics: "sequential",
    });
    expect(toJson(next)).toEqual(["c", "a", "b"]);
  });

  it("supports mixing sequential semantics with an explicit base state", () => {
    const base = createState({ list: [1, 2] }, { actor: "A" });
    const head = applyPatch(base, [{ op: "add", path: "/list/1", value: 9 }], {
      semantics: "sequential",
    });

    const next = applyPatch(
      head,
      [
        { op: "replace", path: "/list/1", value: 20 },
        { op: "add", path: "/list/2", value: 30 },
      ],
      {
        semantics: "sequential",
        base,
      },
    );

    expect(toJson(next)).toEqual({ list: [1, 9, 20, 30] });
  });

  it("applies in-place patches atomically by default", () => {
    const state = createState({ list: ["a"] }, { actor: "A" });
    expect(() =>
      applyPatchInPlace(state, [
        { op: "add", path: "/list/-", value: "b" },
        { op: "remove", path: "/list/5" },
      ]),
    ).toThrow(PatchError);
    expect(toJson(state)).toEqual({ list: ["a"] });
  });

  it("supports non-atomic in-place patching when atomic is disabled", () => {
    const state = createState({ list: ["a"] }, { actor: "A" });
    expect(() =>
      applyPatchInPlace(
        state,
        [
          { op: "add", path: "/list/-", value: "b" },
          { op: "remove", path: "/list/5" },
        ],
        { atomic: false },
      ),
    ).toThrow(PatchError);
    expect(toJson(state)).toEqual({ list: ["a", "b"] });
  });

  it("applies patches as an actor and advances an external version vector", () => {
    const doc = docFromJson({ list: ["a"] }, newDotGen("origin", 0));
    const vv: VersionVector = {};

    const first = applyPatchAsActor(doc, vv, "A", [{ op: "add", path: "/list/-", value: "b" }]);

    expect(materialize(doc.root)).toEqual({ list: ["a"] });
    expect(toJson(first.state)).toEqual({ list: ["a", "b"] });
    expect(first.vv["A"]).toBe(first.state.clock.ctr);

    const second = applyPatchAsActor(first.state.doc, first.vv, "A", [
      { op: "add", path: "/list/-", value: "c" },
    ]);

    expect(toJson(second.state)).toEqual({ list: ["a", "b", "c"] });
    expect(second.vv["A"]).toBe(second.state.clock.ctr);
    expect(second.vv["A"] ?? 0).toBeGreaterThan(first.vv["A"] ?? 0);
  });

  it("recovers from stale actor clocks by scanning observed dots in the document", () => {
    const initial = createState({ n: 0 }, { actor: "A" });
    const once = applyPatch(initial, [{ op: "replace", path: "/n", value: 1 }]);
    const advanced = applyPatch(once, [{ op: "replace", path: "/n", value: 2 }]);

    const staleVv: VersionVector = { A: 1 };
    const next = applyPatchAsActor(advanced.doc, staleVv, "A", [
      { op: "replace", path: "/n", value: 3 },
    ]);

    expect(toJson(next.state)).toEqual({ n: 3 });
    expect(next.state.clock.ctr).toBeGreaterThan(advanced.clock.ctr);
    expect(next.vv["A"]).toBe(next.state.clock.ctr);
  });

  it("exposes non-throwing apply helpers with typed reasons", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "test", path: "/a", value: 2 }]);
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.code).toBe(409);
      expect(result.error.reason).toBe("TEST_FAILED");
    }
    expect(toJson(state)).toEqual({ a: 1 });
  });

  it("returns typed errors when copy source is missing in tryApplyPatch", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "copy", from: "/b", path: "/c" }]);

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.reason).toBe("MISSING_PARENT");
      expect(result.error.path).toBe("/b");
      expect(result.error.opIndex).toBe(0);
    }
  });

  it("returns typed errors when copy source pointer is invalid in tryApplyPatch", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "copy", from: "b", path: "/c" }]);

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.reason).toBe("INVALID_POINTER");
      expect(result.error.path).toBe("b");
      expect(result.error.opIndex).toBe(0);
    }
  });

  it("maps lookup invalid array index tokens to INVALID_POINTER", () => {
    const state = createState({ list: [1] }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "copy", from: "/list/x", path: "/c" }]);

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.reason).toBe("INVALID_POINTER");
      expect(result.error.path).toBe("/list/x");
      expect(result.error.opIndex).toBe(0);
    }
  });

  it("maps lookup non-container traversal to INVALID_TARGET", () => {
    const state = createState({ num: 1 }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "copy", from: "/num/x", path: "/c" }]);

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.reason).toBe("INVALID_TARGET");
      expect(result.error.path).toBe("/num/x");
      expect(result.error.opIndex).toBe(0);
    }
  });

  it("throws PatchError with typed metadata when move source is missing", () => {
    const state = createState({ a: 1 }, { actor: "A" });

    try {
      applyPatch(state, [{ op: "move", from: "/b", path: "/c" }]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      if (error instanceof PatchError) {
        expect(error.reason).toBe("MISSING_PARENT");
        expect(error.path).toBe("/b");
        expect(error.opIndex).toBe(0);
      }
      return;
    }

    throw new Error("Expected PatchError");
  });

  it("throws PatchError with typed metadata for out-of-bounds move source index", () => {
    const state = createState({ list: [1] }, { actor: "A" });

    try {
      applyPatch(state, [{ op: "move", from: "/list/2", path: "/list/0" }]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      if (error instanceof PatchError) {
        expect(error.reason).toBe("OUT_OF_BOUNDS");
        expect(error.path).toBe("/list/2");
        expect(error.opIndex).toBe(0);
      }
      return;
    }

    throw new Error("Expected PatchError");
  });

  it("supports non-throwing in-place application", () => {
    const state = createState({ list: ["a"] }, { actor: "A" });
    const result = tryApplyPatchInPlace(state, [{ op: "remove", path: "/list/5" }]);
    expect(result.ok).toBeFalse();
    expect(toJson(state)).toEqual({ list: ["a"] });
  });

  it("validates patches without mutating caller data", () => {
    const base: JsonValue = { list: ["a"] };
    const valid = validateJsonPatch(base, [{ op: "add", path: "/list/1", value: "b" }]);
    expect(valid).toEqual({ ok: true });

    const invalid = validateJsonPatch(base, [{ op: "replace", path: "/list/-", value: "x" }]);
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) {
      expect(invalid.error.reason).toBe("INVALID_POINTER");
    }

    expect(base).toEqual({ list: ["a"] });
  });
});

describe("json pointer parsing", () => {
  it("parses pointers and unescapes tokens", () => {
    expect(parseJsonPointer("")).toEqual([]);
    expect(parseJsonPointer("/a~1b")).toEqual(["a/b"]);
    expect(parseJsonPointer("/~0")).toEqual(["~"]);
    expect(parseJsonPointer("/")).toEqual([""]);
    expect(parseJsonPointer("/a//b")).toEqual(["a", "", "b"]);
  });

  it("throws on invalid pointer", () => {
    expect(() => parseJsonPointer("a")).toThrow();
  });

  it("rejects invalid escape sequences", () => {
    expect(() => parseJsonPointer("/a~2b")).toThrow();
    expect(() => parseJsonPointer("/a~")).toThrow();
  });

  it("round-trips stringify/parse for edge cases", () => {
    const paths = [[], [""], ["a/b"], ["~"], ["a", "", "b"], ["~0", "~1", "a~b/"]];

    for (const path of paths) {
      const ptr = stringifyJsonPointer(path);
      expect(parseJsonPointer(ptr)).toEqual(path);
    }
  });
});

describe("RGA operations", () => {
  it("linearizes elements by insDot order", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const d3 = dot("B", 1);

    rgaInsertAfter(seq, "HEAD", dotToElemId(d2), d2, newReg("b", d2));
    rgaInsertAfter(seq, "HEAD", dotToElemId(d1), d1, newReg("a", d1));
    rgaInsertAfter(seq, "HEAD", dotToElemId(d3), d3, newReg("c", d3));

    expect(rgaLinearizeIds(seq)).toEqual([dotToElemId(d2), dotToElemId(d3), dotToElemId(d1)]);
  });

  it("linearizes depth-first across branches", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const d3 = dot("B", 1);
    const d4 = dot("B", 2);

    const id1 = dotToElemId(d1);
    const id2 = dotToElemId(d2);
    const id3 = dotToElemId(d3);
    const id4 = dotToElemId(d4);

    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, id1, id2, d2, newReg("b", d2));
    rgaInsertAfter(seq, "HEAD", id3, d3, newReg("c", d3));
    rgaInsertAfter(seq, id3, id4, d4, newReg("d", d4));

    expect(rgaLinearizeIds(seq)).toEqual([id3, id4, id1, id2]);
  });

  it("skips tombstoned elements", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);

    const id1 = dotToElemId(d1);
    const id2 = dotToElemId(d2);

    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, id1, id2, d2, newReg("b", d2));

    rgaDelete(seq, id1);

    expect(rgaLinearizeIds(seq)).toEqual([id2]);
  });

  it("computes prev id for insert at index", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const id1 = dotToElemId(d1);
    const id2 = dotToElemId(d2);

    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, id1, id2, d2, newReg("b", d2));

    expect(rgaPrevForInsertAtIndex(seq, 0)).toBe("HEAD");
    expect(rgaPrevForInsertAtIndex(seq, 1)).toBe(id1);
    expect(rgaPrevForInsertAtIndex(seq, 2)).toBe(id2);
  });

  it("uses last element as prev when index is beyond length", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const id1 = dotToElemId(d1);
    const id2 = dotToElemId(d2);

    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, id1, id2, d2, newReg("b", d2));

    expect(rgaPrevForInsertAtIndex(seq, 10)).toBe(id2);
  });

  it("is idempotent on duplicate insert", () => {
    const seq = newSeq();
    const d1 = dot("A", 1);
    const id1 = dotToElemId(d1);
    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("b", d1));
    expect(rgaLinearizeIds(seq)).toEqual([id1]);
  });

  it("ignores delete of unknown id", () => {
    const seq = newSeq();
    expect(() => rgaDelete(seq, "missing")).not.toThrow();
    expect(rgaLinearizeIds(seq)).toEqual([]);
  });

  it("returns HEAD for prev on empty sequence", () => {
    const seq = newSeq();
    expect(rgaPrevForInsertAtIndex(seq, 0)).toBe("HEAD");
    expect(rgaPrevForInsertAtIndex(seq, 10)).toBe("HEAD");
  });
});

describe("object and LWW operations", () => {
  it("objRemove wins over older objSet", () => {
    const obj = newObj();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);

    objSet(obj, "k", newReg("v", d1), d1);
    objRemove(obj, "k", d2);
    objSet(obj, "k", newReg("x", d1), d1);

    expect(obj.entries.has("k")).toBeFalse();
  });

  it("objSet overwrites with newer dot and can resurrect after older delete", () => {
    const obj = newObj();
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const d3 = dot("A", 3);

    objSet(obj, "k", newReg("v1", d1), d1);
    objSet(obj, "k", newReg("v2", d2), d2);
    expect(materialize(obj)).toEqual({ k: "v2" });

    objRemove(obj, "k", d1);
    expect(obj.entries.has("k")).toBeFalse();

    objSet(obj, "k", newReg("v3", d3), d3);
    expect(materialize(obj)).toEqual({ k: "v3" });
  });

  it("lwwSet applies total order tie-breaker", () => {
    const reg = newReg("a", dot("A", 1));

    lwwSet(reg, "b", dot("B", 1)); // same ctr, actor B > A
    expect(reg.value).toBe("b");

    lwwSet(reg, "c", dot("A", 1)); // same ctr, actor A < B, ignored
    expect(reg.value).toBe("b");

    lwwSet(reg, "d", dot("A", 2)); // higher ctr always wins
    expect(reg.value).toBe("d");
  });
});

describe("materialize", () => {
  it("materializes nested objects and arrays", () => {
    const d1 = dot("A", 1);
    const root = newObj();
    const seq = newSeq();
    const aId = dotToElemId(dot("A", 2));

    rgaInsertAfter(seq, "HEAD", aId, dot("A", 2), newReg("x", d1));
    objSet(root, "arr", seq, d1);
    objSet(root, "num", newReg(42, d1), d1);

    expect(materialize(root)).toEqual({ arr: ["x"], num: 42 });
  });

  it("round-trips docFromJson for objects", () => {
    const value: JsonValue = { a: 1, b: [true, { c: "x" }], d: null };
    const doc = docFromJsonWithDot(value, dot("A", 1));
    expect(materialize(doc.root)).toEqual(value);
  });

  it("round-trips docFromJson for array roots", () => {
    const value: JsonValue = [1, { a: "b" }, [false]];
    const doc = docFromJsonWithDot(value, dot("A", 1));
    expect(materialize(doc.root)).toEqual(value);
  });

  it("round-trips docFromJson with a dot generator", () => {
    const value: JsonValue = { a: [1, 2], b: { c: "x" } };
    const nextDot = newDotGen("A", 0);
    const doc = docFromJson(value, nextDot);
    expect(materialize(doc.root)).toEqual(value);
  });

  it("materializes deeply nested object nodes", () => {
    const depth = 8_000;
    const root = makeDeepObjectNode(depth, "leaf");
    const value = materialize(root);
    expect(readDeepObjectLeaf(value, depth)).toBe("leaf");
  });

  it("throws typed depth errors for unsupported materialize nesting", () => {
    const root = makeDeepObjectNode(MAX_TRAVERSAL_DEPTH + 1, "leaf");
    expect(() => materialize(root)).toThrow(TraversalDepthError);
  });
});

describe("serialization", () => {
  it("serializes and deserializes documents", () => {
    const doc = docFromJsonWithDot({ list: ["a", "b"], meta: { ok: true } }, dot("A", 1));
    const payload: SerializedDoc = serializeDoc(doc);
    const restored = deserializeDoc(payload);

    expect(materialize(restored.root)).toEqual(materialize(doc.root));
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it("preserves tombstones and RGA deletions", () => {
    const d1 = dot("A", 1);
    const d2 = dot("A", 2);
    const d3 = dot("A", 3);

    const seq = newSeq();
    const id1 = dotToElemId(d1);
    const id2 = dotToElemId(d2);
    rgaInsertAfter(seq, "HEAD", id1, d1, newReg("a", d1));
    rgaInsertAfter(seq, id1, id2, d2, newReg("b", d2));
    rgaDelete(seq, id1);

    const obj = newObj();
    objSet(obj, "keep", newReg("x", d1), d1);
    objSet(obj, "drop", newReg("y", d2), d2);
    objRemove(obj, "drop", d3);
    objSet(obj, "arr", seq, d2);

    const doc = { root: obj };
    const payload = serializeDoc(doc);
    const restored = deserializeDoc(payload);

    expect(materialize(restored.root)).toEqual({ keep: "x", arr: ["b"] });
    if (restored.root.kind === "obj") {
      const restoredSeq = restored.root.entries.get("arr")?.node;
      if (restoredSeq && restoredSeq.kind === "seq") {
        expect(rgaLinearizeIds(restoredSeq)).toEqual([id2]);
      } else {
        throw new Error("Expected restored seq");
      }
    } else {
      throw new Error("Expected restored obj");
    }
  });

  it("serializes and deserializes state with clocks", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const payload = serializeState(state);
    const restored = deserializeState(payload);

    expect(toJson(restored)).toEqual({ a: 1 });
    expect(restored.clock.actor).toBe("A");
    expect(restored.clock.ctr).toBe(state.clock.ctr);

    const next = applyPatch(restored, [{ op: "replace", path: "/a", value: 2 }]);
    expect(toJson(restored)).toEqual({ a: 1 });
    expect(toJson(next)).toEqual({ a: 2 });
  });

  it("rejects sequence elements whose key does not match element id", () => {
    const malformed = {
      root: {
        kind: "seq",
        elems: {
          "A:1": {
            id: "A:2",
            prev: "HEAD",
            tombstone: false,
            value: { kind: "lww", value: 1, dot: { actor: "A", ctr: 1 } },
            insDot: { actor: "A", ctr: 1 },
          },
        },
      },
    } as unknown as SerializedDoc;

    try {
      deserializeDoc(malformed);
    } catch (error) {
      expect(error).toBeInstanceOf(DeserializeError);
      if (error instanceof DeserializeError) {
        expect(error.reason).toBe("INVALID_SERIALIZED_INVARIANT");
        expect(error.path).toBe("/root/elems/A:1/id");
      }
      return;
    }

    throw new Error("Expected deserializeDoc to reject mismatched sequence ids");
  });

  it("rejects sequence elements whose prev points to a missing id", () => {
    const malformed = {
      root: {
        kind: "seq",
        elems: {
          "A:1": {
            id: "A:1",
            prev: "missing",
            tombstone: false,
            value: { kind: "lww", value: 1, dot: { actor: "A", ctr: 1 } },
            insDot: { actor: "A", ctr: 1 },
          },
        },
      },
    } as unknown as SerializedDoc;

    try {
      deserializeDoc(malformed);
    } catch (error) {
      expect(error).toBeInstanceOf(DeserializeError);
      if (error instanceof DeserializeError) {
        expect(error.reason).toBe("INVALID_SERIALIZED_INVARIANT");
        expect(error.path).toBe("/root/elems/A:1/prev");
      }
      return;
    }

    throw new Error("Expected deserializeDoc to reject missing sequence predecessors");
  });

  it("rejects invalid state clock shape with typed path context", () => {
    const malformed = {
      doc: {
        root: { kind: "lww", value: 1, dot: { actor: "A", ctr: 1 } },
      },
      clock: {
        actor: 42,
        ctr: "bad",
      },
    } as unknown;

    try {
      deserializeState(malformed as never);
    } catch (error) {
      expect(error).toBeInstanceOf(DeserializeError);
      if (error instanceof DeserializeError) {
        expect(error.reason).toBe("INVALID_SERIALIZED_SHAPE");
        expect(error.path).toBe("/clock/actor");
      }
      return;
    }

    throw new Error("Expected deserializeState to throw for invalid clock shape");
  });
});

describe("doc helpers", () => {
  it("cloneDoc creates an independent copy", () => {
    const base = docFromJsonWithDot({ a: 1 }, dot("A", 1));
    const copy = cloneDoc(base);

    if (copy.root.kind !== "obj") {
      throw new Error("Expected object root");
    }

    objSet(copy.root, "a", newReg(2, dot("A", 2)), dot("A", 2));

    expect(materialize(base.root)).toEqual({ a: 1 });
    expect(materialize(copy.root)).toEqual({ a: 2 });
  });
});
