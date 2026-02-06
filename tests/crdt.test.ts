import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyIntentsToCrdt,
  applyPatch,
  applyPatchAsActor,
  applyPatchInPlace,
  cloneClock,
  compareDot,
  compileJsonPatchToIntent,
  diffJsonPatch,
  createClock,
  nextDotForActor,
  observeDot,
  createState,
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
  toJson,
  vvHasDot,
  vvMerge,
  type Dot,
  type SerializedDoc,
  type IntentOp,
  ROOT_KEY,
  HEAD,
  type CrdtState,
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

function runTypecheck(source: string, args: string[]): { exitCode: number; output: string } {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const tempName = `.tmp-ts-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`;
  const tempPath = `${rootDir}${tempName}`;

  writeFileSync(tempPath, source, "utf8");

  try {
    const result = Bun.spawnSync({
      cmd: [
        "./node_modules/.bin/tsc",
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        ...args,
        tempName,
      ],
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
    return {
      exitCode: result.exitCode ?? -1,
      output,
    };
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
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

  it("supports test operations against an explicit base doc", () => {
    const base = createState({ a: 1 }, { actor: "A" });
    const head = createState({ a: 2 }, { actor: "A" });
    const next = applyPatch(head, [{ op: "test", path: "/a", value: 1 }], {
      base: base.doc,
      testAgainst: "base",
    });
    expect(toJson(next)).toEqual({ a: 2 });
  });

  it("supports test operations against head when base differs", () => {
    const base = createState({ a: 1 }, { actor: "A" });
    const head = createState({ a: 2 }, { actor: "A" });
    const next = applyPatch(head, [{ op: "test", path: "/a", value: 2 }], {
      base: base.doc,
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
        base: base.doc,
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

  it("supports mixing sequential semantics with an explicit base doc", () => {
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
        base: base.doc,
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
      { t: "ObjSet", path: [], key: "d", value: 2, mode: "add" },
      { t: "ObjRemove", path: [], key: "b" },
    ]);
  });

  it("compiles root add/replace/remove to a root set intent", () => {
    const base: JsonValue = { a: 1 };

    expect(compileJsonPatchToIntent(base, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual([
      { t: "ObjSet", path: [], key: ROOT_KEY, value: { b: 2 } },
    ]);

    expect(compileJsonPatchToIntent(base, [{ op: "add", path: "", value: [1, 2] }])).toEqual([
      { t: "ObjSet", path: [], key: ROOT_KEY, value: [1, 2] },
    ]);

    expect(compileJsonPatchToIntent(base, [{ op: "remove", path: "" }])).toEqual([
      { t: "ObjSet", path: [], key: ROOT_KEY, value: null },
    ]);
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
      { t: "ArrInsert", path: ["list"], index: 0, value: "b" },
      { t: "ArrDelete", path: ["list"], index: 1 },
    ]);
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

  it("compiles root move/copy", () => {
    const base: JsonValue = { a: 1 };
    const copyPatch: JsonPatchOp[] = [{ op: "copy", from: "", path: "/b" }];
    const movePatch: JsonPatchOp[] = [{ op: "move", from: "", path: "/b" }];

    expect(compileJsonPatchToIntent(base, copyPatch)).toEqual([
      { t: "ObjSet", path: [], key: "b", value: { a: 1 }, mode: "add" },
    ]);
    expect(compileJsonPatchToIntent(base, movePatch)).toEqual([
      { t: "ObjSet", path: [], key: "b", value: { a: 1 }, mode: "add" },
      { t: "ObjSet", path: [], key: ROOT_KEY, value: null },
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

  it("applies root replace and remove", () => {
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
    expect(removeRes).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toBeNull();
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

  it("creates missing arrays on insert at index 0", () => {
    const baseJson: JsonValue = {};
    const baseDoc = docFromJsonWithDot(baseJson, dot("A", 0));
    const headDoc = cloneDoc(baseDoc);
    const patch: JsonPatchOp[] = [{ op: "add", path: "/list/0", value: "x" }];

    const res = jsonPatchToCrdt(baseDoc, headDoc, patch, newDotGen("A", 1));
    expect(res).toEqual({ ok: true });
    expect(materialize(headDoc.root)).toEqual({ list: ["x"] });
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

describe("package exports", () => {
  it("points main/module/types and exports to existing built files", () => {
    const rootUrl = new URL("../", import.meta.url);
    type ExportTypes =
      | string
      | {
          import?: string;
          require?: string;
          default?: string;
        };

    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("package.json", rootUrl)), "utf8"),
    ) as {
      main: string;
      module: string;
      types: string;
      exports: {
        ".": { import: string; require: string; types: ExportTypes };
        "./internals": { import: string; require: string; types: ExportTypes };
      };
    };

    const collectTypePaths = (
      value:
        | string
        | {
            import?: string;
            require?: string;
            default?: string;
          },
    ): string[] => {
      if (typeof value === "string") {
        return [value];
      }

      return Object.values(value).filter((v): v is string => typeof v === "string");
    };

    const paths = [
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.exports["."].import,
      pkg.exports["."].require,
      ...collectTypePaths(pkg.exports["."].types),
      pkg.exports["./internals"].import,
      pkg.exports["./internals"].require,
      ...collectTypePaths(pkg.exports["./internals"].types),
    ];

    for (const rel of paths) {
      const normalized = rel.startsWith("./") ? rel.slice(2) : rel;
      expect(existsSync(fileURLToPath(new URL(normalized, rootUrl)))).toBeTrue();
    }
  });
});

describe("consumer TypeScript compatibility", () => {
  it("typechecks ESM imports under NodeNext", () => {
    const result = runTypecheck(
      `import { applyPatch, createState } from "json-patch-to-crdt";
const state = createState({ a: 1 }, { actor: "A" });
applyPatch(state, [{ op: "replace", path: "/a", value: 2 }]);
`,
      ["--module", "NodeNext", "--moduleResolution", "NodeNext"],
    );

    if (result.exitCode !== 0) {
      throw new Error(result.output);
    }
  });

  it("typechecks CJS require imports under Node16", () => {
    const result = runTypecheck(
      `import pkg = require("json-patch-to-crdt");
const state = pkg.createState({ a: 1 }, { actor: "A" });
pkg.applyPatch(state, [{ op: "replace", path: "/a", value: 2 }]);
`,
      ["--module", "Node16", "--moduleResolution", "Node16"],
    );

    if (result.exitCode !== 0) {
      throw new Error(result.output);
    }
  });
});
