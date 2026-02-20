/* oxlint-disable no-unused-vars */
import { expect } from "bun:test";

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

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function applyJsonPatch(base: JsonValue, patch: JsonPatchOp[]): JsonValue {
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

export class SeededRng {
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

export function randomPrimitive(rng: SeededRng): JsonValue {
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

export function randomValue(rng: SeededRng, depth = 2): JsonValue {
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

export function randomArray(rng: SeededRng, maxLen = 5): JsonValue[] {
  const len = rng.int(maxLen + 1);
  const out: JsonValue[] = [];
  for (let i = 0; i < len; i++) {
    out.push(randomPrimitive(rng));
  }
  return out;
}

export function randomObject(rng: SeededRng, maxKeys = 4): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const keys = ["a", "b", "c", "d", "e"];
  const count = rng.int(maxKeys + 1);
  for (let i = 0; i < count; i++) {
    const key = keys[rng.int(keys.length)]!;
    out[key] = randomPrimitive(rng);
  }
  return out;
}

export function randomValidPatchProgram(
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

export function shuffleArray<T>(rng: SeededRng, items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export function randomObjectWithOrder(
  rng: SeededRng,
  entries: Array<[string, JsonValue]>,
): JsonValue {
  const order = shuffleArray(rng, entries);
  const obj: Record<string, JsonValue> = {};
  for (const [k, v] of order) {
    obj[k] = v;
  }
  return obj;
}

export function dot(actor: string, ctr: number): Dot {
  return { actor, ctr };
}

export function newDotGen(actor = "A", start = 0) {
  let ctr = start;
  return () => ({ actor, ctr: ++ctr });
}

export function makeDeepObject(depth: number, leaf: JsonValue): JsonValue {
  let value = leaf;
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
}

export function readDeepObjectLeaf(value: JsonValue, depth: number): JsonValue {
  let current = value;
  for (let i = 0; i < depth; i++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`expected object at depth ${i}`);
    }

    const next = (current as Record<string, JsonValue>).child;
    if (next === undefined) {
      throw new Error(`missing child at depth ${i}`);
    }

    current = next;
  }

  return current;
}

export function makeDeepObjectNode(depth: number, leaf: JsonValue, actor = "A"): Doc["root"] {
  if (depth === 0) {
    return newReg(leaf, dot(actor, 1));
  }

  const root = newObj();
  let current = root;
  let ctr = 0;

  for (let i = 0; i < depth; i++) {
    const entryDot = dot(actor, ++ctr);
    if (i === depth - 1) {
      objSet(current, "child", newReg(leaf, dot(actor, ++ctr)), entryDot);
      break;
    }

    const child = newObj();
    objSet(current, "child", child, entryDot);
    current = child;
  }

  return root;
}

export type SyncRecord = {
  head: Doc;
  vv: VersionVector;
  history: Map<string, Doc>;
};

export function cloneVv(vv: VersionVector): VersionVector {
  return { ...vv };
}

export function maxVvCtr(vv: VersionVector): number {
  let max = 0;
  for (const ctr of Object.values(vv)) {
    if (ctr > max) {
      max = ctr;
    }
  }
  return max;
}

export function versionKey(vv: VersionVector): string {
  return Object.entries(vv)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actor, ctr]) => `${actor}:${ctr}`)
    .join("|");
}

export function createSyncRecord(initial: JsonValue, actor = "server"): SyncRecord {
  const origin = createState(initial, { actor });
  const vv: VersionVector = { [origin.clock.actor]: origin.clock.ctr };
  const history = new Map<string, Doc>();
  history.set(versionKey(vv), cloneDoc(origin.doc));
  return { head: origin.doc, vv, history };
}

export function snapshotFromRecord(record: SyncRecord, vv: VersionVector): Doc {
  const doc = record.history.get(versionKey(vv));
  if (!doc) {
    throw new Error(`missing snapshot for version ${versionKey(vv)}`);
  }
  return cloneDoc(doc);
}

export function applyIncomingPatch(
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

export function expectDeltaApplies(base: Doc, outPatch: JsonPatchOp[], head: Doc): void {
  const baseJson = materialize(base.root);
  const applied = applyJsonPatch(baseJson, outPatch);
  expect(applied).toEqual(materialize(head.root));
}

export type SerializedSyncRecord = {
  head: SerializedDoc;
  vv: VersionVector;
  history: Array<{ version: string; doc: SerializedDoc }>;
};

export function serializeSyncRecord(record: SyncRecord): SerializedSyncRecord {
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

export function deserializeSyncRecord(data: SerializedSyncRecord): SyncRecord {
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

export function compactHistory(record: SyncRecord, keep: VersionVector[]): void {
  const keepKeys = new Set(keep.map((vv) => versionKey(vv)));
  for (const key of Array.from(record.history.keys())) {
    if (!keepKeys.has(key)) {
      record.history.delete(key);
    }
  }
}

export type SyncEnvelope = {
  id: string;
  actor: string;
  baseVv: VersionVector;
  patch: JsonPatchOp[];
  options?: { testAgainst?: "head" | "base"; semantics?: "sequential" | "base" };
};

export function applyIncomingWithDedupe(
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

export type SyncJson = {
  arr: JsonValue[];
  obj: Record<string, JsonValue>;
  flag: boolean;
  count: number;
};

export function asSyncJson(value: JsonValue): SyncJson {
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

export function randomSyncPatchForSnapshot(base: SyncJson, rng: SeededRng): JsonPatchOp[] {
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
