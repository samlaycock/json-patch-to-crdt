import { describe, expect, it } from "bun:test";

import {
  applyIntentsToCrdt,
  applyPatch,
  applyPatchAsActor,
  applyPatchInPlace,
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
  mergeState,
  tryMergeDoc,
  tryMergeState,
  toJson,
  vvHasDot,
  vvMerge,
  type Dot,
  type SerializedDoc,
  type IntentOp,
  ROOT_KEY,
  HEAD,
  type CrdtState,
  type Doc,
  type JsonPatchOp,
  type JsonValue,
  type VersionVector,
} from "../src/internals";

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function applyJsonPatch(base: JsonValue, patch: JsonPatchOp[]): JsonValue {
  let doc: JsonValue = cloneJson(base);

  for (const op of patch) {
    const path = parseJsonPointer(op.path);
    if (path.length === 0) {
      if (op.op === "remove") {
        doc = null;
        continue;
      }
      if (op.op === "add" || op.op === "replace") {
        doc = cloneJson(op.value);
        continue;
      }
      throw new Error(`Unsupported op ${op.op} at root`);
    }

    const parentPath = path.slice(0, -1);
    const key = path[path.length - 1]!;
    const parent = getAtJson(doc, parentPath);

    if (Array.isArray(parent)) {
      const idx = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(idx)) {
        throw new Error(`Invalid array index ${key}`);
      }

      if (op.op === "add") {
        if (idx < 0 || idx > parent.length) {
          throw new Error(`Index out of bounds ${idx}`);
        }
        parent.splice(idx, 0, cloneJson(op.value));
        continue;
      }

      if (op.op === "remove") {
        if (idx < 0 || idx >= parent.length) {
          throw new Error(`Index out of bounds ${idx}`);
        }
        parent.splice(idx, 1);
        continue;
      }

      if (op.op === "replace") {
        if (idx < 0 || idx >= parent.length) {
          throw new Error(`Index out of bounds ${idx}`);
        }
        parent[idx] = cloneJson(op.value);
        continue;
      }

      throw new Error(`Unsupported op ${op.op} for array`);
    }

    if (!parent || typeof parent !== "object") {
      throw new Error("Parent is not a container");
    }

    const obj = parent as Record<string, JsonValue>;
    if (op.op === "add" || op.op === "replace") {
      obj[key] = cloneJson(op.value);
      continue;
    }
    if (op.op === "remove") {
      delete obj[key];
      continue;
    }

    throw new Error(`Unsupported op ${op.op} for object`);
  }

  return doc;
}

class SeededRng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  int(max: number): number {
    return this.next() % max;
  }

  bool(): boolean {
    return (this.next() & 1) === 1;
  }
}

function randomPrimitive(rng: SeededRng): JsonValue {
  const pick = rng.int(4);
  if (pick === 0) {
    return null;
  }
  if (pick === 1) {
    return rng.bool();
  }
  if (pick === 2) {
    return rng.int(10);
  }
  return `s${rng.int(10)}`;
}

function randomValue(rng: SeededRng, depth = 2): JsonValue {
  if (depth <= 0) {
    return randomPrimitive(rng);
  }

  const pick = rng.int(3);
  if (pick === 0) {
    return randomPrimitive(rng);
  }
  if (pick === 1) {
    const arr = randomArray(rng, 4);
    return arr.map((v) => (rng.bool() ? v : randomValue(rng, depth - 1)));
  }

  const obj = randomObject(rng, 4);
  for (const key of Object.keys(obj)) {
    if (rng.bool()) {
      obj[key] = randomValue(rng, depth - 1);
    }
  }
  return obj;
}

function randomArray(rng: SeededRng, maxLen = 5): JsonValue[] {
  const len = rng.int(maxLen + 1);
  const out: JsonValue[] = [];
  for (let i = 0; i < len; i++) {
    out.push(randomPrimitive(rng));
  }
  return out;
}

function randomObject(rng: SeededRng, maxKeys = 4): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const keys = ["a", "b", "c", "d", "e"];
  const count = rng.int(maxKeys + 1);
  for (let i = 0; i < count; i++) {
    const key = keys[rng.int(keys.length)]!;
    out[key] = randomPrimitive(rng);
  }
  return out;
}

function randomValidPatchProgram(
  rng: SeededRng,
  steps = 8,
): { base: JsonValue; patch: JsonPatchOp[]; expected: JsonValue } {
  const base = {
    arr: randomArray(rng, 4),
    obj: randomObject(rng, 3),
  } as { arr: JsonValue[]; obj: Record<string, JsonValue> };

  let current = cloneJson(base);
  const patch: JsonPatchOp[] = [];
  const keyPool = ["a", "b", "c", "d", "e"];

  for (let i = 0; i < steps; i++) {
    if (rng.bool()) {
      const arr = current.arr;
      const canMutateExisting = arr.length > 0;
      const mode = canMutateExisting ? rng.int(3) : 0;

      if (mode === 0) {
        const idx = rng.int(arr.length + 1);
        const useDash = rng.bool();
        patch.push({
          op: "add",
          path: useDash ? "/arr/-" : `/arr/${idx}`,
          value: randomPrimitive(rng),
        });
      } else if (mode === 1) {
        const idx = rng.int(arr.length);
        patch.push({ op: "remove", path: `/arr/${idx}` });
      } else {
        const idx = rng.int(arr.length);
        patch.push({ op: "replace", path: `/arr/${idx}`, value: randomPrimitive(rng) });
      }
    } else {
      const keys = Object.keys(current.obj);
      const canMutateExisting = keys.length > 0;
      const mode = canMutateExisting ? rng.int(3) : 0;

      if (mode === 0) {
        const key = keyPool[rng.int(keyPool.length)]!;
        patch.push({ op: "add", path: `/obj/${key}`, value: randomPrimitive(rng) });
      } else if (mode === 1) {
        const key = keys[rng.int(keys.length)]!;
        patch.push({ op: "remove", path: `/obj/${key}` });
      } else {
        const key = keys[rng.int(keys.length)]!;
        patch.push({ op: "replace", path: `/obj/${key}`, value: randomPrimitive(rng) });
      }
    }

    current = applyJsonPatch(current, [patch[patch.length - 1]!]) as {
      arr: JsonValue[];
      obj: Record<string, JsonValue>;
    };
  }

  return { base, patch, expected: current };
}

function shuffleArray<T>(rng: SeededRng, items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function randomObjectWithOrder(rng: SeededRng, entries: Array<[string, JsonValue]>): JsonValue {
  const order = shuffleArray(rng, entries);
  const obj: Record<string, JsonValue> = {};
  for (const [k, v] of order) {
    obj[k] = v;
  }
  return obj;
}

function dot(actor: string, ctr: number): Dot {
  return { actor, ctr };
}

function newDotGen(actor = "A", start = 0) {
  let ctr = start;
  return () => ({ actor, ctr: ++ctr });
}

type SyncRecord = {
  head: Doc;
  vv: VersionVector;
  history: Map<string, Doc>;
};

function cloneVv(vv: VersionVector): VersionVector {
  return { ...vv };
}

function maxVvCtr(vv: VersionVector): number {
  let max = 0;
  for (const ctr of Object.values(vv)) {
    if (ctr > max) {
      max = ctr;
    }
  }
  return max;
}

function versionKey(vv: VersionVector): string {
  return Object.entries(vv)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actor, ctr]) => `${actor}:${ctr}`)
    .join("|");
}

function createSyncRecord(initial: JsonValue, actor = "server"): SyncRecord {
  const origin = createState(initial, { actor });
  const vv: VersionVector = { [origin.clock.actor]: origin.clock.ctr };
  const history = new Map<string, Doc>();
  history.set(versionKey(vv), cloneDoc(origin.doc));
  return { head: origin.doc, vv, history };
}

function snapshotFromRecord(record: SyncRecord, vv: VersionVector): Doc {
  const doc = record.history.get(versionKey(vv));
  if (!doc) {
    throw new Error(`missing snapshot for version ${versionKey(vv)}`);
  }
  return cloneDoc(doc);
}

function applyIncomingPatch(
  record: SyncRecord,
  actor: string,
  baseVv: VersionVector,
  patch: JsonPatchOp[],
  options: { testAgainst?: "head" | "base"; semantics?: "sequential" | "base" } = {},
): { base: Doc; outPatch: JsonPatchOp[]; head: Doc; vv: VersionVector } {
  const base = snapshotFromRecord(record, baseVv);
  const applyVv = cloneVv(record.vv);
  if (applyVv[actor] === undefined) {
    // Seed unseen actors from the current max so first writes participate in LWW ordering.
    applyVv[actor] = maxVvCtr(applyVv);
  }

  const applied = applyPatchAsActor(record.head, applyVv, actor, patch, {
    base,
    testAgainst: options.testAgainst,
    semantics: options.semantics,
  });
  const head = applied.state.doc;
  const vv = cloneVv(applied.vv);
  const outPatch = crdtToJsonPatch(base, head);

  record.head = head;
  record.vv = vv;
  record.history.set(versionKey(vv), cloneDoc(head));

  return { base, outPatch, head, vv };
}

function expectDeltaApplies(base: Doc, outPatch: JsonPatchOp[], head: Doc): void {
  const baseJson = materialize(base.root);
  const applied = applyJsonPatch(baseJson, outPatch);
  expect(applied).toEqual(materialize(head.root));
}

type SerializedSyncRecord = {
  head: SerializedDoc;
  vv: VersionVector;
  history: Array<{ version: string; doc: SerializedDoc }>;
};

function serializeSyncRecord(record: SyncRecord): SerializedSyncRecord {
  const history: Array<{ version: string; doc: SerializedDoc }> = [];
  for (const [version, doc] of record.history.entries()) {
    history.push({
      version,
      doc: serializeDoc(doc),
    });
  }

  return {
    head: serializeDoc(record.head),
    vv: cloneVv(record.vv),
    history,
  };
}

function deserializeSyncRecord(data: SerializedSyncRecord): SyncRecord {
  const history = new Map<string, Doc>();
  for (const entry of data.history) {
    history.set(entry.version, deserializeDoc(entry.doc));
  }

  return {
    head: deserializeDoc(data.head),
    vv: cloneVv(data.vv),
    history,
  };
}

function compactHistory(record: SyncRecord, keep: VersionVector[]): void {
  const keepKeys = new Set(keep.map((vv) => versionKey(vv)));
  for (const key of Array.from(record.history.keys())) {
    if (!keepKeys.has(key)) {
      record.history.delete(key);
    }
  }
}

type SyncEnvelope = {
  id: string;
  actor: string;
  baseVv: VersionVector;
  patch: JsonPatchOp[];
  options?: { testAgainst?: "head" | "base"; semantics?: "sequential" | "base" };
};

function applyIncomingWithDedupe(
  record: SyncRecord,
  seen: Set<string>,
  envelope: SyncEnvelope,
): { base: Doc; outPatch: JsonPatchOp[]; head: Doc; vv: VersionVector } | null {
  if (seen.has(envelope.id)) {
    return null;
  }

  const result = applyIncomingPatch(
    record,
    envelope.actor,
    envelope.baseVv,
    envelope.patch,
    envelope.options,
  );
  seen.add(envelope.id);
  return result;
}

type SyncJson = {
  arr: JsonValue[];
  obj: Record<string, JsonValue>;
  flag: boolean;
  count: number;
};

function asSyncJson(value: JsonValue): SyncJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected sync object root");
  }
  const doc = value as Record<string, JsonValue>;
  if (!Array.isArray(doc.arr)) {
    throw new Error("expected arr array");
  }
  if (!doc.obj || typeof doc.obj !== "object" || Array.isArray(doc.obj)) {
    throw new Error("expected obj object");
  }
  if (typeof doc.flag !== "boolean") {
    throw new Error("expected boolean flag");
  }
  if (typeof doc.count !== "number") {
    throw new Error("expected numeric count");
  }

  return {
    arr: doc.arr,
    obj: doc.obj as Record<string, JsonValue>,
    flag: doc.flag,
    count: doc.count,
  };
}

function randomSyncPatchForSnapshot(base: SyncJson, rng: SeededRng): JsonPatchOp[] {
  const objKeys = Object.keys(base.obj);
  const keyPool = ["a", "b", "c", "d", "e", "f"];

  if (rng.int(6) === 0) {
    if (base.arr.length > 0) {
      return [
        { op: "remove", path: `/arr/${rng.int(base.arr.length)}` },
        { op: "add", path: "/arr/-", value: randomPrimitive(rng) },
      ];
    }

    const key = keyPool[rng.int(keyPool.length)]!;
    return [
      { op: "add", path: `/obj/${key}`, value: randomPrimitive(rng) },
      { op: "replace", path: "/count", value: base.count + 1 },
    ];
  }

  const choice = rng.int(9);
  if (choice === 0) {
    const insertIndex = base.arr.length === 0 ? 0 : rng.int(base.arr.length + 1);
    return [
      {
        op: "add",
        path: rng.bool() ? "/arr/-" : `/arr/${insertIndex}`,
        value: randomPrimitive(rng),
      },
    ];
  }
  if (choice === 1) {
    if (base.arr.length === 0) {
      return [{ op: "add", path: "/arr/0", value: randomPrimitive(rng) }];
    }
    return [
      { op: "replace", path: `/arr/${rng.int(base.arr.length)}`, value: randomPrimitive(rng) },
    ];
  }
  if (choice === 2) {
    if (base.arr.length === 0) {
      return [{ op: "add", path: "/arr/-", value: randomPrimitive(rng) }];
    }
    return [{ op: "remove", path: `/arr/${rng.int(base.arr.length)}` }];
  }
  if (choice === 3) {
    const key = keyPool[rng.int(keyPool.length)]!;
    return [{ op: "add", path: `/obj/${key}`, value: randomPrimitive(rng) }];
  }
  if (choice === 4) {
    if (objKeys.length === 0) {
      return [{ op: "add", path: "/obj/a", value: randomPrimitive(rng) }];
    }
    const key = objKeys[rng.int(objKeys.length)]!;
    return [{ op: "replace", path: `/obj/${key}`, value: randomPrimitive(rng) }];
  }
  if (choice === 5) {
    if (objKeys.length === 0) {
      return [{ op: "add", path: "/obj/a", value: randomPrimitive(rng) }];
    }
    const key = objKeys[rng.int(objKeys.length)]!;
    return [{ op: "remove", path: `/obj/${key}` }];
  }
  if (choice === 6) {
    return [{ op: "replace", path: "/count", value: base.count + rng.int(5) + 1 }];
  }
  if (choice === 7) {
    return [{ op: "replace", path: "/flag", value: !base.flag }];
  }

  if (objKeys.length === 0) {
    return [{ op: "add", path: "/obj/a", value: randomPrimitive(rng) }];
  }
  const fromKey = objKeys[rng.int(objKeys.length)]!;
  const toKey = `copy_${rng.int(6)}`;
  return [{ op: "copy", from: `/obj/${fromKey}`, path: `/obj/${toKey}` }];
}

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
