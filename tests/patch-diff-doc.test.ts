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

describe("compileJsonPatchToIntent", () => {
  it("compiles add/remove/replace to intents", () => {
    const base: JsonValue = { list: ["a"], obj: {} };
    const patch: JsonPatchOp[] = [
      { op: "add", path: "/list/1", value: "b" },
      { op: "replace", path: "/list/0", value: "z" },
      { op: "remove", path: "/list/1" },
      { op: "add", path: "/obj/key", value: true },
    ];

    const intents = compileJsonPatchToIntent(base, patch);
    expect(intents).toEqual([
      { t: "ArrInsert", path: ["list"], index: 1, value: "b" },
      { t: "ArrReplace", path: ["list"], index: 0, value: "z" },
      { t: "ArrDelete", path: ["list"], index: 1 },
      { t: "ObjSet", path: ["obj"], key: "key", value: true, mode: "add" },
    ]);
  });

  it("compiles move/copy into add + optional remove", () => {
    const base: JsonValue = { a: 1, b: 2 };
    const patch: JsonPatchOp[] = [
      { op: "copy", from: "/a", path: "/c" },
      { op: "move", from: "/b", path: "/d" },
    ];

    const intents = compileJsonPatchToIntent(base, patch);
    expect(intents).toEqual([
      { t: "ObjSet", path: [], key: "c", value: 1, mode: "add" },
      { t: "ObjRemove", path: [], key: "b" },
      { t: "ObjSet", path: [], key: "d", value: 2, mode: "add" },
    ]);
  });

  it("compiles root add/replace and rejects root remove", () => {
    const base: JsonValue = { a: 1 };

    expect(compileJsonPatchToIntent(base, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual([
      { t: "ObjSet", path: [], key: ROOT_KEY, value: { b: 2 } },
    ]);

    expect(compileJsonPatchToIntent(base, [{ op: "add", path: "", value: [1, 2] }])).toEqual([
      { t: "ObjSet", path: [], key: ROOT_KEY, value: [1, 2] },
    ]);

    expect(() => compileJsonPatchToIntent(base, [{ op: "remove", path: "" }])).toThrow();
  });

  it("compiles array append using '-' index", () => {
    const base: JsonValue = { list: ["a"] };
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/-", value: "b" }];

    expect(compileJsonPatchToIntent(base, patch)).toEqual([
      {
        t: "ArrInsert",
        path: ["list"],
        index: Number.POSITIVE_INFINITY,
        value: "b",
      },
    ]);
  });

  it("compiles array move/copy to array intents", () => {
    const base: JsonValue = { list: ["a", "b"] };
    const patch: JsonPatchOp[] = [{ op: "move", from: "/list/1", path: "/list/0" }];

    expect(compileJsonPatchToIntent(base, patch)).toEqual([
      { t: "ArrDelete", path: ["list"], index: 1 },
      { t: "ArrInsert", path: ["list"], index: 0, value: "b" },
    ]);
  });

  it("compiles self-move as a no-op in sequential semantics", () => {
    const base: JsonValue = { a: 1 };
    const patch: JsonPatchOp[] = [{ op: "move", from: "/a", path: "/a" }];

    expect(compileJsonPatchToIntent(base, patch)).toEqual([]);
  });

  it("throws on invalid JSON pointer", () => {
    const base: JsonValue = { a: 1 };
    expect(() => compileJsonPatchToIntent(base, [{ op: "add", path: "a", value: 2 }])).toThrow();
  });

  it("throws when object parents are missing", () => {
    const base: JsonValue = {};
    expect(() =>
      compileJsonPatchToIntent(base, [{ op: "add", path: "/missing/key", value: 1 }]),
    ).toThrow();
  });

  it("throws when object replace/remove target is missing", () => {
    const base: JsonValue = {};
    expect(() =>
      compileJsonPatchToIntent(base, [{ op: "replace", path: "/k", value: 1 }]),
    ).toThrow();
    expect(() => compileJsonPatchToIntent(base, [{ op: "remove", path: "/k" }])).toThrow();
  });

  it("compiles root copy and rejects strict root move into a descendant", () => {
    const base: JsonValue = { a: 1 };
    const copyPatch: JsonPatchOp[] = [{ op: "copy", from: "", path: "/b" }];
    const movePatch: JsonPatchOp[] = [{ op: "move", from: "", path: "/b" }];

    expect(compileJsonPatchToIntent(base, copyPatch)).toEqual([
      { t: "ObjSet", path: [], key: "b", value: { a: 1 }, mode: "add" },
    ]);
    expect(() => compileJsonPatchToIntent(base, movePatch)).toThrow();
  });

  it("rejects '-' for array remove/replace at compile time", () => {
    const base: JsonValue = { list: ["a"] };

    expect(() => compileJsonPatchToIntent(base, [{ op: "remove", path: "/list/-" }])).toThrow();
    expect(() =>
      compileJsonPatchToIntent(base, [{ op: "replace", path: "/list/-", value: "x" }]),
    ).toThrow();
  });

  it("treats numeric tokens as object keys when parent is an object", () => {
    const base: JsonValue = { obj: { "0": "a" } };
    const patch: JsonPatchOp[] = [{ op: "replace", path: "/obj/0", value: "b" }];

    expect(compileJsonPatchToIntent(base, patch)).toEqual([
      { t: "ObjSet", path: ["obj"], key: "0", value: "b", mode: "replace" },
    ]);
  });

  it("rejects array indices with leading zeros", () => {
    const base: JsonValue = { arr: [1, 2] };

    try {
      compileJsonPatchToIntent(base, [{ op: "replace", path: "/arr/01", value: 9 }]);
    } catch (error) {
      expect(error).toBeInstanceOf(PatchCompileError);
      if (error instanceof PatchCompileError) {
        expect(error.reason).toBe("INVALID_POINTER");
      }
      return;
    }

    throw new Error("Expected PatchCompileError");
  });

  it("allows numeric-looking object keys with leading zeros", () => {
    const base: JsonValue = { obj: { "01": "a" } };
    const patch: JsonPatchOp[] = [{ op: "replace", path: "/obj/01", value: "b" }];

    expect(compileJsonPatchToIntent(base, patch)).toEqual([
      { t: "ObjSet", path: ["obj"], key: "01", value: "b", mode: "replace" },
    ]);
  });
});

describe("diffJsonPatch", () => {
  it("replaces the root when primitives change", () => {
    const ops = diffJsonPatch(1, 2);
    expect(ops).toEqual([{ op: "replace", path: "", value: 2 }]);
  });

  it("adds and removes object keys", () => {
    const base: JsonValue = { a: 1, b: 2 };
    const next: JsonValue = { b: 2, c: 3 };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([
      { op: "remove", path: "/a" },
      { op: "add", path: "/c", value: 3 },
    ]);
  });

  it("handles nested remove/add/replace in objects", () => {
    const base: JsonValue = { obj: { a: 1, b: 2, c: { x: 1 } } };
    const next: JsonValue = { obj: { b: 3, d: 4, c: { x: 2 } } };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([
      { op: "remove", path: "/obj/a" },
      { op: "add", path: "/obj/d", value: 4 },
      { op: "replace", path: "/obj/b", value: 3 },
      { op: "replace", path: "/obj/c/x", value: 2 },
    ]);
  });

  it("replaces arrays as atomic values when requested", () => {
    const base: JsonValue = { arr: [1, 2] };
    const next: JsonValue = { arr: [1, 3] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "atomic" });
    expect(ops).toEqual([{ op: "replace", path: "/arr", value: [1, 3] }]);
  });

  it("replaces when value types change", () => {
    const base: JsonValue = { v: { a: 1 } };
    const next: JsonValue = { v: [1, 2] };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([{ op: "replace", path: "/v", value: [1, 2] }]);
  });

  it("handles null vs object differences", () => {
    const base: JsonValue = { v: null };
    const next: JsonValue = { v: { a: 1 } };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([{ op: "replace", path: "/v", value: { a: 1 } }]);
  });

  it("supports LCS array strategy for index-level edits", () => {
    const base: JsonValue = { arr: [1, 2, 3] };
    const next: JsonValue = { arr: [1, 3, 4] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([
      { op: "remove", path: "/arr/1" },
      { op: "add", path: "/arr/2", value: 4 },
    ]);
  });

  it("uses LCS array strategy by default", () => {
    const base: JsonValue = { arr: [1, 2] };
    const next: JsonValue = { arr: [1, 3] };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([{ op: "replace", path: "/arr/1", value: 3 }]);
  });

  it("falls back to atomic array replacement for large arrays by default", () => {
    const baseArr = Array.from({ length: 600 }, (_, idx) => idx);
    const nextArr = [...baseArr];
    nextArr[300] = -1;

    const base: JsonValue = { arr: baseArr };
    const next: JsonValue = { arr: nextArr };
    const ops = diffJsonPatch(base, next);

    expect(ops).toEqual([{ op: "replace", path: "/arr", value: nextArr }]);
  });

  it("allows overriding the LCS guardrail for larger arrays", () => {
    const baseArr = Array.from({ length: 600 }, (_, idx) => idx);
    const nextArr = [...baseArr];
    nextArr[300] = -1;

    const base: JsonValue = { arr: baseArr };
    const next: JsonValue = { arr: nextArr };
    const ops = diffJsonPatch(base, next, {
      arrayStrategy: "lcs",
      lcsMaxCells: 500_000,
    });

    expect(ops).toEqual([{ op: "replace", path: "/arr/300", value: -1 }]);
  });

  it("supports forcing atomic fallback with a low LCS guardrail", () => {
    const base: JsonValue = { arr: [1, 2, 3] };
    const next: JsonValue = { arr: [1, 4, 3] };

    const ops = diffJsonPatch(base, next, {
      arrayStrategy: "lcs",
      lcsMaxCells: 1,
    });

    expect(ops).toEqual([{ op: "replace", path: "/arr", value: [1, 4, 3] }]);
  });

  it("produces nested array paths with LCS", () => {
    const base: JsonValue = { obj: { arr: [1, 2] } };
    const next: JsonValue = { obj: { arr: [1, 3] } };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([{ op: "replace", path: "/obj/arr/1", value: 3 }]);
  });

  it("handles repeated elements with LCS", () => {
    const base: JsonValue = { arr: [1, 2, 1, 2] };
    const next: JsonValue = { arr: [1, 2, 2] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([{ op: "remove", path: "/arr/2" }]);
  });

  it("treats reorders as remove/add under LCS", () => {
    const base: JsonValue = { arr: [1, 2, 3] };
    const next: JsonValue = { arr: [2, 1, 3] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([
      { op: "remove", path: "/arr/0" },
      { op: "add", path: "/arr/1", value: 1 },
    ]);
  });

  it("can append elements with LCS", () => {
    const base: JsonValue = { arr: [1] };
    const next: JsonValue = { arr: [1, 2, 3] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([
      { op: "add", path: "/arr/1", value: 2 },
      { op: "add", path: "/arr/2", value: 3 },
    ]);
  });

  it("can remove leading elements with LCS", () => {
    const base: JsonValue = { arr: [1, 2, 3] };
    const next: JsonValue = { arr: [2, 3] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([{ op: "remove", path: "/arr/0" }]);
  });

  it("uses replace when a single element changes under LCS strategy", () => {
    const base: JsonValue = { arr: [1, 2] };
    const next: JsonValue = { arr: [1, 3] };
    const ops = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
    expect(ops).toEqual([{ op: "replace", path: "/arr/1", value: 3 }]);
  });

  it("escapes JSON pointer segments", () => {
    const base: JsonValue = { "a/b": 1, "~": 2 };
    const next: JsonValue = { "a/b": 1, "~": 3 };
    const ops = diffJsonPatch(base, next);
    expect(ops).toEqual([{ op: "replace", path: "/~0", value: 3 }]);
    expect(stringifyJsonPointer(["a/b"])).toBe("/a~1b");
  });

  it("applies diffJsonPatch to produce the next value", () => {
    const base: JsonValue = { a: 1, arr: [1, 2] };
    const next: JsonValue = { a: 2, arr: [1, 3] };
    const patch = diffJsonPatch(base, next);
    const applied = applyJsonPatch(base, patch);
    expect(applied).toEqual(next);
  });

  it("produces patches that transform base into next (random objects)", () => {
    const rng = new SeededRng(42);
    for (let i = 0; i < 50; i++) {
      const base = randomObject(rng);
      const next = randomObject(rng);
      const patch = diffJsonPatch(base, next);
      const applied = applyJsonPatch(base, patch);
      expect(applied).toEqual(next);
    }
  });

  it("produces patches that transform base into next (random arrays, atomic)", () => {
    const rng = new SeededRng(1337);
    for (let i = 0; i < 50; i++) {
      const base = { arr: randomArray(rng) };
      const next = { arr: randomArray(rng) };
      const patch = diffJsonPatch(base, next);
      const applied = applyJsonPatch(base, patch);
      expect(applied).toEqual(next);
    }
  });

  it("produces patches that transform base into next (random arrays, LCS)", () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 50; i++) {
      const base = { arr: randomArray(rng) };
      const next = { arr: randomArray(rng) };
      const patch = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
      const applied = applyJsonPatch(base, patch);
      expect(applied).toEqual(next);
    }
  });

  it("produces patches that transform base into next (random nested values)", () => {
    const rng = new SeededRng(99);
    for (let i = 0; i < 80; i++) {
      const base = randomValue(rng, 3);
      const next = randomValue(rng, 3);
      const patch = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
      const applied = applyJsonPatch(base, patch);
      expect(applied).toEqual(next);
    }
  });

  it("produces identical patches across repeated runs", () => {
    const rng = new SeededRng(555);
    for (let i = 0; i < 30; i++) {
      const base = randomValue(rng, 3);
      const next = randomValue(rng, 3);
      const patch1 = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
      const patch2 = diffJsonPatch(base, next, { arrayStrategy: "lcs" });
      expect(patch1).toEqual(patch2);
    }
  });

  it("produces identical patches for atomic arrays across runs", () => {
    const rng = new SeededRng(2024);
    for (let i = 0; i < 30; i++) {
      const base = { arr: randomArray(rng) };
      const next = { arr: randomArray(rng) };
      const patch1 = diffJsonPatch(base, next, { arrayStrategy: "atomic" });
      const patch2 = diffJsonPatch(base, next, { arrayStrategy: "atomic" });
      expect(patch1).toEqual(patch2);
    }
  });

  it("is stable across different object key insertion orders", () => {
    const rng = new SeededRng(777);
    const entries: Array<[string, JsonValue]> = [
      ["b", 1],
      ["a", 2],
      ["c", 3],
    ];
    const base1 = randomObjectWithOrder(rng, entries);
    const base2 = randomObjectWithOrder(rng, entries);
    const next1 = randomObjectWithOrder(rng, [
      ["a", 2],
      ["c", 4],
      ["d", 5],
    ]);
    const next2 = randomObjectWithOrder(rng, [
      ["d", 5],
      ["c", 4],
      ["a", 2],
    ]);

    const patch1 = diffJsonPatch(base1, next1);
    const patch2 = diffJsonPatch(base2, next2);
    expect(patch1).toEqual(patch2);
  });
});

describe("applyIntentsToCrdt", () => {
  it("evaluates test ops against base or head", () => {
    const baseDoc = docFromJsonWithDot({ a: 1 }, dot("A", 0));
    const headDoc = docFromJsonWithDot({ a: 2 }, dot("A", 0));
    const intents: IntentOp[] = [{ t: "Test", path: ["a"], value: 1 }];

    const okBase = applyIntentsToCrdt(baseDoc, headDoc, intents, newDotGen("A", 1), "base");
    expect(okBase).toEqual({ ok: true });

    const okHead = applyIntentsToCrdt(baseDoc, headDoc, intents, newDotGen("A", 2), "head");
    expect(okHead.ok).toBeFalse();
  });

  it("rejects object writes when parent object path is missing", () => {
    const baseDoc = docFromJsonWithDot(1, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const intents: IntentOp[] = [{ t: "ObjSet", path: ["a", "b"], key: "c", value: 1 }];

    const res = applyIntentsToCrdt(baseDoc, headDoc, intents, newDotGen("A", 1));
    expect(res.ok).toBeFalse();
    expect(materialize(headDoc.root)).toEqual(1);
  });

  it("can fast-forward insert counters without repeated dot generation", () => {
    const baseSeq = newSeq();
    const headSeq = newSeq();
    const baseDoc = { root: baseSeq };
    const headDoc = { root: headSeq };

    const seedDot = dot("A", 1);
    const seedId = dotToElemId(seedDot);
    rgaInsertAfter(baseSeq, HEAD, seedId, seedDot, newReg("seed", seedDot));
    rgaInsertAfter(headSeq, HEAD, seedId, seedDot, newReg("seed", seedDot));

    const remoteDot = dot("B", 5_000_000);
    const remoteId = dotToElemId(remoteDot);
    rgaInsertAfter(headSeq, HEAD, remoteId, remoteDot, newReg("remote", remoteDot));

    let ctr = 1;
    let nextCalls = 0;
    const nextDot = () => {
      nextCalls += 1;
      return dot("A", ++ctr);
    };
    const bumpCounterAbove = (seenCtr: number) => {
      if (ctr < seenCtr) {
        ctr = seenCtr;
      }
    };

    const res = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ArrInsert", path: [], index: 0, value: "local" }],
      nextDot,
      "head",
      bumpCounterAbove,
    );

    expect(res).toEqual({ ok: true });
    expect(nextCalls).toBeLessThanOrEqual(4);
    expect(ctr).toBeGreaterThan(5_000_000);
    expect(materialize(headDoc.root)).toEqual(["local", "remote", "seed"]);
  });

  it("returns a typed error when skewed inserts cannot be bounded without fast-forwarding", () => {
    const baseSeq = newSeq();
    const headSeq = newSeq();
    const baseDoc = { root: baseSeq };
    const headDoc = { root: headSeq };

    const seedDot = dot("A", 1);
    const seedId = dotToElemId(seedDot);
    rgaInsertAfter(baseSeq, HEAD, seedId, seedDot, newReg("seed", seedDot));
    rgaInsertAfter(headSeq, HEAD, seedId, seedDot, newReg("seed", seedDot));

    const remoteDot = dot("B", 5_000);
    const remoteId = dotToElemId(remoteDot);
    rgaInsertAfter(headSeq, HEAD, remoteId, remoteDot, newReg("remote", remoteDot));

    let ctr = 1;
    let nextCalls = 0;
    const nextDot = () => {
      nextCalls += 1;
      return dot("A", ++ctr);
    };

    const res = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ArrInsert", path: [], index: 0, value: "local" }],
      nextDot,
    );

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.reason).toBe("DOT_GENERATION_EXHAUSTED");
      expect(res.code).toBe(409);
    }
    expect(nextCalls).toBeLessThanOrEqual(1_500);
    expect(materialize(headDoc.root)).toEqual(["remote", "seed"]);
  });

  it("auto-creates arrays on insert at index 0 or append when base is missing", () => {
    const baseDoc = docFromJsonWithDot({}, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const res0 = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ArrInsert", path: ["list"], index: 0, value: "a" }],
      newDotGen("A", 1),
    );
    expect(res0).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["a"] });

    const headDoc2 = cloneDoc(baseDoc);
    const resAppend = applyIntentsToCrdt(
      baseDoc,
      headDoc2,
      [
        {
          t: "ArrInsert",
          path: ["list"],
          index: Number.POSITIVE_INFINITY,
          value: "b",
        },
      ],
      newDotGen("A", 1),
    );
    expect(resAppend).toEqual({ ok: true });
    expect(materialize(headDoc2.root)).toEqual({ list: ["b"] });
  });

  it("rejects missing base arrays for inserts in strictParents mode", () => {
    const baseDoc = docFromJsonWithDot({}, dot("A", 0));
    const headDoc = docFromJsonWithDot({ list: [] }, dot("A", 0));

    const res = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ArrInsert", path: ["list"], index: 0, value: "a" }],
      newDotGen("A", 1),
      "head",
      undefined,
      { strictParents: true },
    );

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.reason).toBe("MISSING_PARENT");
    }
    expect(materialize(headDoc.root)).toEqual({ list: [] });
  });

  it("rejects array insert when base is missing and index is not 0 or append", () => {
    const baseDoc = docFromJsonWithDot({}, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const res = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ArrInsert", path: ["list"], index: 1, value: "x" }],
      newDotGen("A", 1),
    );

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.code).toBe(409);
    }
  });

  it("rejects object writes when parent path is not an object", () => {
    const baseDoc = docFromJsonWithDot({ a: 1 }, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const intents: IntentOp[] = [{ t: "ObjSet", path: ["a"], key: "b", value: 2 }];
    const res = applyIntentsToCrdt(baseDoc, headDoc, intents, newDotGen("A", 1));
    expect(res.ok).toBeFalse();
    expect(materialize(headDoc.root)).toEqual({ a: 1 });
  });

  it("rejects object replace and remove when the key is missing", () => {
    const baseDoc = docFromJsonWithDot({}, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const replaceRes = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ObjSet", path: [], key: "x", value: 1, mode: "replace" }],
      newDotGen("A", 1),
    );
    expect(replaceRes.ok).toBeFalse();

    const removeRes = applyIntentsToCrdt(
      baseDoc,
      headDoc,
      [{ t: "ObjRemove", path: [], key: "x" }],
      newDotGen("A", 1),
    );
    expect(removeRes.ok).toBeFalse();
  });
});

describe("jsonPatchToCrdt", () => {
  it("applies array insert and replace", () => {
    const baseJson: JsonValue = { list: ["a", "b"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const nextDot = newDotGen("A", 10);

    const patch: JsonPatchOp[] = [
      { op: "add", path: "/list/1", value: "x" },
      { op: "replace", path: "/list/0", value: "z" },
    ];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, nextDot);
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["z", "x", "b"] });
  });

  it("applies root replace and rejects root remove in strict mode", () => {
    const baseJson: JsonValue = { a: 1 };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const replaceRes = jsonPatchToCrdt(
      baseDoc,
      headDoc,
      [{ op: "replace", path: "", value: { b: 2 } }],
      newDotGen("A", 1),
    );
    expect(replaceRes).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ b: 2 });

    const removeRes = jsonPatchToCrdt(
      baseDoc,
      headDoc,
      [{ op: "remove", path: "" }],
      newDotGen("A", 10),
    );
    expect(removeRes.ok).toBeFalse();
    if (!removeRes.ok) {
      expect(removeRes.reason).toBe("INVALID_TARGET");
    }
    expect(materialize(headDoc.root)).toEqual({ b: 2 });
  });

  it("rejects root remove via options-object overload", () => {
    const baseDoc = docFromJsonWithDot({ a: 1 }, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const res = jsonPatchToCrdt({
      base: baseDoc,
      head: headDoc,
      patch: [{ op: "remove", path: "" }],
      newDot: newDotGen("A", 1),
    });

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.reason).toBe("INVALID_TARGET");
    }
    expect(materialize(headDoc.root)).toEqual({ a: 1 });
  });

  it("appends using '-' index", () => {
    const baseJson: JsonValue = { list: ["a", "b"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/-", value: "c" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 10));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["a", "b", "c"] });
  });

  it("supports array root inserts", () => {
    const baseJson: JsonValue = [1, 2];
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const patch: JsonPatchOp[] = [{ op: "add", path: "/1", value: 99 }];
    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("B", 0));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual([1, 99, 2]);
  });

  it("copies and moves object keys", () => {
    const baseJson: JsonValue = { a: 1, b: 2 };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [
      { op: "copy", from: "/a", path: "/c" },
      { op: "move", from: "/b", path: "/d" },
    ];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ a: 1, c: 1, d: 2 });
  });

  it("applies forward array move with RFC ordering semantics", () => {
    const baseJson: JsonValue = { list: ["a", "b", "c"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "move", from: "/list/0", path: "/list/2" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["b", "c", "a"] });
  });

  it("treats self-move as a no-op", () => {
    const baseJson: JsonValue = { a: 1 };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "move", from: "/a", path: "/a" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ a: 1 });
  });

  it("matches applyPatch for sequential move edge cases", () => {
    const patch: JsonPatchOp[] = [{ op: "move", from: "/list/0", path: "/list/2" }];
    const state = createState({ list: ["a", "b", "c"] }, { actor: "A" });
    const highLevel = applyPatch(state, patch, { semantics: "sequential" });

    const baseDoc = cloneDoc(state.doc);
    const headDoc = cloneDoc(state.doc);
    const lowLevel = jsonPatchToCrdt({
      base: baseDoc,
      head: headDoc,
      patch,
      newDot: newDotGen("A", state.clock.ctr),
      semantics: "sequential",
    });

    expect(lowLevel).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual(toJson(highLevel));
  });

  it("rejects out-of-bounds array inserts and deletes", () => {
    const baseJson: JsonValue = { list: ["a", "b"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const insertRes = jsonPatchToCrdt(
      baseDoc,
      headDoc,
      [{ op: "add", path: "/list/5", value: "x" }],
      newDotGen("A", 1),
    );
    expect(insertRes.ok).toBeFalse();

    const deleteRes = jsonPatchToCrdt(
      baseDoc,
      headDoc,
      [{ op: "remove", path: "/list/5" }],
      newDotGen("A", 2),
    );
    expect(deleteRes.ok).toBeFalse();
  });

  it("rejects replace after delete on same base element", () => {
    const baseJson: JsonValue = { list: ["a"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [
      { op: "remove", path: "/list/0" },
      { op: "replace", path: "/list/0", value: "z" },
    ];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res.ok).toBeFalse();
  });

  it("rejects missing arrays on insert at index 0 in strict mode", () => {
    const baseJson: JsonValue = {};
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/0", value: "x" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.reason).toBe("MISSING_PARENT");
    }
    expect(materialize(headDoc.root)).toEqual({});
  });

  it("rejects array insert at non-zero index when base array is missing", () => {
    const baseJson: JsonValue = {};
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/1", value: "x" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res.ok).toBeFalse();
  });

  it("can evaluate test ops against base snapshot", () => {
    const baseJson: JsonValue = { a: 1 };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = docFromJsonWithDot({ a: 2 }, dot("A", 0));
    const patch: JsonPatchOp[] = [{ op: "test", path: "/a", value: 1 }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1), "base");
    expect(res).toEqual({ ok: true });
  });

  it("fails test op when value mismatches", () => {
    const baseJson: JsonValue = { a: 1 };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);

    const patch: JsonPatchOp[] = [{ op: "test", path: "/a", value: 2 }];
    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.code).toBe(409);
      expect(res.message).toContain("test failed");
    }
  });

  it("propagates base index mapping for deletes", () => {
    const baseJson: JsonValue = { list: ["a", "b"] };
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [
      { op: "remove", path: "/list/1" },
      { op: "add", path: "/list/1", value: "x" },
    ];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["a", "x"] });
  });

  it("safe wrapper returns a 409 result for compile-time patch errors", () => {
    const baseDoc = docFromJsonWithDot({ a: 1 }, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "a", value: 2 }];

    const res = jsonPatchToCrdtSafe(baseDoc, headDoc, patch, newDotGen("A", 1));

    expect(res.ok).toBeFalse();
    if (!res.ok) {
      expect(res.code).toBe(409);
      expect(res.message.length).toBeGreaterThan(0);
    }
    expect(materialize(headDoc.root)).toEqual({ a: 1 });
  });

  it("safe wrapper matches jsonPatchToCrdt on successful patches", () => {
    const baseDoc = docFromJsonWithDot({ list: ["a"] }, dot("A", 0));
    const headSafe = cloneDoc(baseDoc);
    const headRaw = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/-", value: "b" }];

    const safeRes = jsonPatchToCrdtSafe(baseDoc, headSafe, patch, newDotGen("A", 1));
    const rawRes = jsonPatchToCrdt(baseDoc, headRaw, patch, newDotGen("A", 1));

    expect(safeRes).toEqual(rawRes);
    expect(materialize(headSafe.root)).toEqual(materialize(headRaw.root));
  });
});

describe("conversion invariants (fuzz)", () => {
  it("matches plain JSON patch execution across random valid programs", () => {
    const rng = new SeededRng(2026);

    for (let i = 0; i < 120; i++) {
      const { base, patch, expected } = randomValidPatchProgram(rng, 10);

      const state = createState(base, { actor: "A" });
      const highLevel = tryApplyPatch(state, patch);
      expect(highLevel.ok).toBeTrue();
      if (!highLevel.ok) {
        throw new Error(highLevel.error.message);
      }
      expect(toJson(highLevel.state)).toEqual(expected);

      const validated = validateJsonPatch(base, patch);
      expect(validated).toEqual({ ok: true });

      const baseDoc = docFromJsonWithDot(base, dot("A", 0));
      const headDoc = cloneDoc(baseDoc);
      const lowLevel = jsonPatchToCrdt({
        base: baseDoc,
        head: headDoc,
        patch,
        newDot: newDotGen("B", 0),
      });
      expect(lowLevel).toEqual({ ok: true });
      expect(materialize(headDoc.root)).toEqual(expected);
    }
  });

  it("compiles deterministic intents across repeated runs", () => {
    const rng = new SeededRng(909);
    for (let i = 0; i < 80; i++) {
      const { base, patch } = randomValidPatchProgram(rng, 8);
      const intents1 = compileJsonPatchToIntent(base, patch);
      const intents2 = compileJsonPatchToIntent(base, patch);
      expect(intents1).toEqual(intents2);
    }
  });
});

describe("crdtToFullReplace", () => {
  it("emits root replace patch", () => {
    const doc = docFromJsonWithDot({ ok: true }, dot("A", 1));
    expect(crdtToFullReplace(doc)).toEqual([{ op: "replace", path: "", value: { ok: true } }]);
  });

  it("materializes complex documents in a single replace op", () => {
    const doc = docFromJsonWithDot({ list: [1, 2], meta: { ok: true } }, dot("A", 1));
    expect(crdtToFullReplace(doc)).toEqual([
      { op: "replace", path: "", value: { list: [1, 2], meta: { ok: true } } },
    ]);
  });
});

describe("crdtToJsonPatch", () => {
  it("emits a delta when given base and head documents", () => {
    const base = docFromJsonWithDot({ a: 1 }, dot("A", 1));
    const head = docFromJsonWithDot({ a: 2, b: 3 }, dot("A", 2));
    expect(crdtToJsonPatch(base, head)).toEqual([
      { op: "add", path: "/b", value: 3 },
      { op: "replace", path: "/a", value: 2 },
    ]);
  });

  it("passes diff options through for array deltas", () => {
    const base = docFromJsonWithDot({ arr: [1, 2] }, dot("A", 1));
    const head = docFromJsonWithDot({ arr: [1, 3] }, dot("A", 2));
    expect(crdtToJsonPatch(base, head, { arrayStrategy: "lcs" })).toEqual([
      { op: "replace", path: "/arr/1", value: 3 },
    ]);
  });

  it("defaults to LCS array diffs when no options are provided", () => {
    const base = docFromJsonWithDot({ arr: [1, 2] }, dot("A", 1));
    const head = docFromJsonWithDot({ arr: [1, 3] }, dot("A", 2));
    expect(crdtToJsonPatch(base, head)).toEqual([{ op: "replace", path: "/arr/1", value: 3 }]);
  });

  it("round-trips base via delta patch for random nested docs", () => {
    const rng = new SeededRng(123);
    for (let i = 0; i < 60; i++) {
      const baseJson = randomValue(rng, 3);
      const headJson = randomValue(rng, 3);
      const base = docFromJsonWithDot(baseJson, dot("A", i + 1));
      const head = docFromJsonWithDot(headJson, dot("B", i + 1));
      const patch = crdtToJsonPatch(base, head, { arrayStrategy: "lcs" });
      const applied = applyJsonPatch(baseJson, patch);
      expect(applied).toEqual(headJson);
    }
  });

  it("round-trips base via delta patch for random mixed docs", () => {
    const rng = new SeededRng(321);
    for (let i = 0; i < 60; i++) {
      const baseJson = {
        a: randomValue(rng, 2),
        b: randomArray(rng),
        c: randomObject(rng, 3),
      };
      const headJson = {
        a: randomValue(rng, 2),
        b: randomArray(rng),
        c: randomObject(rng, 3),
      };
      const base = docFromJsonWithDot(baseJson, dot("A", i + 1));
      const head = docFromJsonWithDot(headJson, dot("B", i + 1));
      const patch = crdtToJsonPatch(base, head, { arrayStrategy: "lcs" });
      const applied = applyJsonPatch(baseJson, patch);
      expect(applied).toEqual(headJson);
    }
  });

  it("produces stable op ordering for object deltas", () => {
    const base = docFromJsonWithDot({ b: 1, a: 1 }, dot("A", 1));
    const head = docFromJsonWithDot({ c: 2, a: 1 }, dot("A", 2));
    const patch = crdtToJsonPatch(base, head);
    expect(patch).toEqual([
      { op: "remove", path: "/b" },
      { op: "add", path: "/c", value: 2 },
    ]);
  });

  it("produces identical patches across repeated runs", () => {
    const baseJson = { b: 1, a: 1, arr: [2, 1] };
    const headJson = { a: 1, c: 2, arr: [1, 2] };
    const base = docFromJsonWithDot(baseJson, dot("A", 1));
    const head = docFromJsonWithDot(headJson, dot("A", 2));

    const patch1 = crdtToJsonPatch(base, head, { arrayStrategy: "lcs" });
    const patch2 = crdtToJsonPatch(base, head, { arrayStrategy: "lcs" });

    expect(patch1).toEqual(patch2);
  });

  it("is stable across different object key insertion orders", () => {
    const rng = new SeededRng(314);
    const base1 = randomObjectWithOrder(rng, [
      ["b", 1],
      ["a", 1],
      ["arr", [2, 1]],
    ]);
    const base2 = randomObjectWithOrder(rng, [
      ["arr", [2, 1]],
      ["a", 1],
      ["b", 1],
    ]);
    const head1 = randomObjectWithOrder(rng, [
      ["a", 1],
      ["c", 2],
      ["arr", [1, 2]],
    ]);
    const head2 = randomObjectWithOrder(rng, [
      ["arr", [1, 2]],
      ["c", 2],
      ["a", 1],
    ]);

    const patch1 = crdtToJsonPatch(
      docFromJsonWithDot(base1, dot("A", 1)),
      docFromJsonWithDot(head1, dot("A", 2)),
      { arrayStrategy: "lcs" },
    );
    const patch2 = crdtToJsonPatch(
      docFromJsonWithDot(base2, dot("A", 1)),
      docFromJsonWithDot(head2, dot("A", 2)),
      { arrayStrategy: "lcs" },
    );

    expect(patch1).toEqual(patch2);
  });

  it("applies delta patch to CRDT and matches head materialization", () => {
    const baseJson: JsonValue = { list: ["a", "b"], obj: { x: 1 } };
    const headJson: JsonValue = { list: ["a", "b", "c"], obj: { x: 2, y: 3 } };
    const base = docFromJsonWithDot(baseJson, dot("A", 1));
    const head = docFromJsonWithDot(headJson, dot("B", 1));
    const patch = crdtToJsonPatch(base, head, { arrayStrategy: "lcs" });

    const appliedHead = cloneDoc(base);
    const res = jsonPatchToCrdt(base, appliedHead, patch, newDotGen("C", 1));

    expect(res).toEqual({ ok: true });
    expect(materialize(appliedHead.root)).toEqual(headJson);
  });
});

describe("getAtJson", () => {
  it("reads nested values", () => {
    const data: JsonValue = { a: { b: [1, 2] } };
    expect(getAtJson(data, ["a", "b", "1"])).toBe(2);
  });

  it("treats inherited object properties as missing keys", () => {
    const data: JsonValue = {};

    expect(() => getAtJson(data, ["toString"])).toThrow("Missing key 'toString'");
    expect(() => getAtJson(data, ["hasOwnProperty"])).toThrow("Missing key 'hasOwnProperty'");
    expect(() => getAtJson(data, ["__proto__"])).toThrow("Missing key '__proto__'");
  });

  it("throws on missing object keys", () => {
    const data: JsonValue = { a: 1 };
    expect(() => getAtJson(data, ["b"])).toThrow();
  });

  it("throws on invalid array index tokens", () => {
    const data: JsonValue = [1, 2];
    expect(() => getAtJson(data, ["x"])).toThrow();
  });

  it("throws on out-of-bounds array access", () => {
    const data: JsonValue = [1];
    expect(() => getAtJson(data, ["1"])).toThrow();
  });

  it("throws when traversing into non-container", () => {
    const data: JsonValue = 1;
    expect(() => getAtJson(data, ["a"])).toThrow();
  });
});
