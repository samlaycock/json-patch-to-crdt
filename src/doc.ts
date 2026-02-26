import type {
  ApplyError,
  ApplyResult,
  DiffOptions,
  Doc,
  Dot,
  ElemId,
  IntentOp,
  JsonPatchToCrdtOptions,
  JsonPatchOp,
  JsonValue,
  Node,
  ObjNode,
  RgaElem,
  RgaSeq,
} from "./types";

import { TraversalDepthError, assertTraversalDepth, toDepthApplyError } from "./depth";
import { compareDot, dotToElemId } from "./dot";
import { materialize } from "./materialize";
import { newObj, newReg, newSeq, objRemove, objSet } from "./nodes";
import {
  PatchCompileError,
  compileJsonPatchToIntent,
  diffJsonPatch,
  getAtJson,
  jsonEquals,
  parseJsonPointer,
} from "./patch";
import {
  HEAD,
  rgaDelete,
  rgaIdAtIndex,
  rgaInsertAfter,
  rgaLinearizeIds,
  rgaPrevForInsertAtIndex,
} from "./rga";
import { ROOT_KEY } from "./types";

/**
 * Create a CRDT document from a JSON value, using fresh dots for each node.
 * @param value - The JSON value to convert.
 * @param nextDot - A function that generates a unique `Dot` on each call.
 * @returns A new CRDT `Doc`.
 */
export function docFromJson(value: JsonValue, nextDot: () => Dot): Doc {
  return { root: nodeFromJson(value, nextDot) };
}

/**
 * Legacy: create a doc using a single dot with counter offsets for array children.
 * Prefer `docFromJson(value, nextDot)` to ensure unique dots per node.
 */
export function docFromJsonWithDot(value: JsonValue, dot: Dot): Doc {
  return { root: deepNodeFromJson(value, dot) };
}

function getSeqAtPath(doc: Doc, path: string[]): RgaSeq | undefined {
  let cur: Node = doc.root;

  for (const seg of path) {
    if (cur.kind !== "obj") {
      return undefined;
    }

    const ent = (cur as ObjNode).entries.get(seg);

    if (!ent) {
      return undefined;
    }

    cur = ent.node;
  }

  return cur.kind === "seq" ? (cur as RgaSeq) : undefined;
}

function getObjAtPathStrict(
  doc: Doc,
  path: string[],
): { ok: true; obj: ObjNode } | { ok: false; message: string } {
  let cur: Node = doc.root;
  const seen: string[] = [];

  if (path.length === 0) {
    if (cur.kind !== "obj") {
      return { ok: false, message: "expected object at /" };
    }

    return { ok: true, obj: cur as ObjNode };
  }

  for (const seg of path) {
    if (cur.kind !== "obj") {
      return {
        ok: false,
        message: `expected object at /${seen.join("/")}`,
      };
    }

    const entry = (cur as ObjNode).entries.get(seg);
    seen.push(seg);

    if (!entry || entry.node.kind !== "obj") {
      return {
        ok: false,
        message: `expected object at /${seen.join("/")}`,
      };
    }

    cur = entry.node;
  }

  return { ok: true, obj: cur as ObjNode };
}

function ensureSeqAtPath(head: Doc, path: string[], dotForCreate: Dot): RgaSeq {
  let cur: Node = head.root;
  let parent: ObjNode | null = null;
  let parentKey: string | null = null;

  if (path.length === 0) {
    if (head.root.kind !== "seq") {
      head.root = newSeq();
    }
    return head.root as RgaSeq;
  }

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;

    if (cur.kind !== "obj") {
      const replacement = newObj();

      if (parent && parentKey !== null) {
        objSet(parent, parentKey, replacement, dotForCreate);
      } else {
        head.root = replacement;
      }

      cur = replacement;
    }

    const obj = cur as ObjNode;
    const ent = obj.entries.get(seg);

    if (i === path.length - 1) {
      if (!ent || ent.node.kind !== "seq") {
        const seq = newSeq();
        objSet(obj, seg, seq, dotForCreate);
        return seq;
      }

      return ent.node as RgaSeq;
    }

    if (!ent || ent.node.kind !== "obj") {
      const child = newObj();
      objSet(obj, seg, child, dotForCreate);
      parent = obj;
      parentKey = seg;
      cur = child;
    } else {
      parent = obj;
      parentKey = seg;
      cur = ent.node;
    }
  }

  // Unreachable, but TypeScript needs a return.
  if (head.root.kind !== "seq") {
    head.root = newSeq();
  }

  return head.root as RgaSeq;
}

function getNodeAtPath(doc: Doc, path: string[]): Node | undefined {
  let cur: Node = doc.root;

  for (const seg of path) {
    if (cur.kind !== "obj") {
      return undefined;
    }

    const ent = (cur as ObjNode).entries.get(seg);
    if (!ent) {
      return undefined;
    }

    cur = ent.node;
  }

  return cur;
}

function getHeadSeqForBaseArrayIntent(
  head: Doc,
  path: string[],
): { ok: true; seq: RgaSeq } | ApplyError {
  const pointer = `/${path.join("/")}`;
  const headNode = getNodeAtPath(head, path);

  if (!headNode) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: `head array missing at ${pointer}`,
      path: pointer,
    };
  }

  if (headNode.kind !== "seq") {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_TARGET",
      message: `expected array at ${pointer}`,
      path: pointer,
    };
  }

  return { ok: true, seq: headNode };
}

function deepNodeFromJson(value: JsonValue, dot: Dot): Node {
  return deepNodeFromJsonWithDepth(value, dot, 0);
}

function deepNodeFromJsonWithDepth(value: JsonValue, dot: Dot, depth: number): Node {
  assertTraversalDepth(depth);
  // For KV ergonomics we store subtrees structurally:
  // - objects/arrays become CRDT containers
  // - primitives become LWW reg
  // If you prefer "atomic subtrees", just return newReg(value, dot).
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return newReg(value, dot);
  }
  if (Array.isArray(value)) {
    const seq = newSeq();
    let prev = HEAD;
    // insert in order with synthetic dots derived from dot (not great). In production use fresh dots per element.
    // For now, keep it simple: all children get the same dot ordering via ctr offset.
    let ctr = dot.ctr;
    for (const v of value) {
      const childDot: Dot = { actor: dot.actor, ctr: ++ctr };
      const id = dotToElemId(childDot);
      rgaInsertAfter(seq, prev, id, childDot, deepNodeFromJsonWithDepth(v, childDot, depth + 1));
      prev = id;
    }
    return seq;
  }
  const obj = newObj();
  for (const [k, v] of Object.entries(value)) {
    objSet(obj, k, deepNodeFromJsonWithDepth(v, dot, depth + 1), dot);
  }
  return obj;
}

function nodeFromJson(value: JsonValue, nextDot: () => Dot): Node {
  if (isJsonPrimitive(value)) {
    return newReg(value, nextDot());
  }

  const root = Array.isArray(value) ? newSeq() : newObj();
  type ObjFrame = {
    kind: "obj";
    depth: number;
    entries: Array<[string, JsonValue]>;
    index: number;
    target: ObjNode;
  };
  type SeqFrame = {
    kind: "seq";
    depth: number;
    values: JsonValue[];
    index: number;
    prev: ElemId;
    target: RgaSeq;
  };
  type Frame = ObjFrame | SeqFrame;

  const stack: Frame[] = [];
  if (Array.isArray(value)) {
    stack.push({
      kind: "seq",
      depth: 0,
      values: value,
      index: 0,
      prev: HEAD,
      target: root as RgaSeq,
    });
  } else {
    stack.push({
      kind: "obj",
      depth: 0,
      entries: Object.entries(value),
      index: 0,
      target: root as ObjNode,
    });
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "obj") {
      if (frame.index >= frame.entries.length) {
        stack.pop();
        continue;
      }

      const [key, childValue] = frame.entries[frame.index++]!;
      const childDepth = frame.depth + 1;
      assertTraversalDepth(childDepth);

      const entryDot = nextDot();
      if (isJsonPrimitive(childValue)) {
        objSet(frame.target, key, newReg(childValue, nextDot()), entryDot);
        continue;
      }

      if (Array.isArray(childValue)) {
        const childSeq = newSeq();
        objSet(frame.target, key, childSeq, entryDot);
        stack.push({
          kind: "seq",
          depth: childDepth,
          values: childValue,
          index: 0,
          prev: HEAD,
          target: childSeq,
        });
        continue;
      }

      const childObj = newObj();
      objSet(frame.target, key, childObj, entryDot);
      stack.push({
        kind: "obj",
        depth: childDepth,
        entries: Object.entries(childValue),
        index: 0,
        target: childObj,
      });
      continue;
    }

    if (frame.index >= frame.values.length) {
      stack.pop();
      continue;
    }

    const childValue = frame.values[frame.index++]!;
    const childDepth = frame.depth + 1;
    assertTraversalDepth(childDepth);

    const insDot = nextDot();
    const id = dotToElemId(insDot);

    if (isJsonPrimitive(childValue)) {
      rgaInsertAfter(frame.target, frame.prev, id, insDot, newReg(childValue, nextDot()));
      frame.prev = id;
      continue;
    }

    if (Array.isArray(childValue)) {
      const childSeq = newSeq();
      rgaInsertAfter(frame.target, frame.prev, id, insDot, childSeq);
      frame.prev = id;
      stack.push({
        kind: "seq",
        depth: childDepth,
        values: childValue,
        index: 0,
        prev: HEAD,
        target: childSeq,
      });
      continue;
    }

    const childObj = newObj();
    rgaInsertAfter(frame.target, frame.prev, id, insDot, childObj);
    frame.prev = id;
    stack.push({
      kind: "obj",
      depth: childDepth,
      entries: Object.entries(childValue),
      index: 0,
      target: childObj,
    });
  }

  return root;
}

/** Deep-clone a CRDT document. The clone is fully independent of the original. */
export function cloneDoc(doc: Doc): Doc {
  return { root: cloneNode(doc.root) };
}

function cloneNode(node: Node): Node {
  return cloneNodeAtDepth(node, 0);
}

function cloneNodeAtDepth(node: Node, depth: number): Node {
  assertTraversalDepth(depth);
  if (node.kind === "lww") {
    return {
      kind: "lww",
      value: structuredClone(node.value),
      dot: { actor: node.dot.actor, ctr: node.dot.ctr },
    };
  }

  if (node.kind === "obj") {
    const entries = new Map<string, { node: Node; dot: Dot }>();
    for (const [k, v] of node.entries.entries()) {
      entries.set(k, {
        node: cloneNodeAtDepth(v.node, depth + 1),
        dot: { actor: v.dot.actor, ctr: v.dot.ctr },
      });
    }

    const tombstone = new Map<string, Dot>();
    for (const [k, d] of node.tombstone.entries()) {
      tombstone.set(k, { actor: d.actor, ctr: d.ctr });
    }

    return {
      kind: "obj",
      entries,
      tombstone,
    };
  }

  const elems = new Map<string, RgaElem>();
  for (const [id, e] of node.elems.entries()) {
    elems.set(id, {
      id: e.id,
      prev: e.prev,
      tombstone: e.tombstone,
      value: cloneNodeAtDepth(e.value, depth + 1),
      insDot: { actor: e.insDot.actor, ctr: e.insDot.ctr },
    });
  }

  return { kind: "seq", elems };
}

function isJsonPrimitive(value: JsonValue): value is null | string | number | boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

const ARRAY_INDEX_TOKEN_PATTERN = /^(0|[1-9][0-9]*)$/;

function getJsonAtDocPathForTest(doc: Doc, path: string[]): JsonValue {
  let cur: Node = doc.root;

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    assertTraversalDepth(i + 1);

    if (cur.kind === "obj") {
      const ent = cur.entries.get(seg);
      if (!ent) {
        throw new Error(`Missing key '${seg}'`);
      }

      cur = ent.node;
      continue;
    }

    if (cur.kind === "seq") {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(seg)) {
        throw new Error(`Expected array index, got '${seg}'`);
      }

      const idx = Number(seg);
      const id = rgaIdAtIndex(cur, idx);
      if (id === undefined) {
        throw new Error(`Index out of bounds at '${seg}'`);
      }

      cur = cur.elems.get(id)!.value;
      continue;
    }

    throw new Error(`Cannot traverse into non-container at '${seg}'`);
  }

  return cur.kind === "lww" ? cur.value : materialize(cur);
}

// ── Per-intent handlers ─────────────────────────────────────────────

function applyTest(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "Test" }>,
  evalTestAgainst: "head" | "base",
): ApplyResult | null {
  let got: JsonValue;

  try {
    const targetDoc = evalTestAgainst === "head" ? head : base;
    got = getJsonAtDocPathForTest(targetDoc, it.path);
  } catch {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `test path missing at /${it.path.join("/")}`,
      path: `/${it.path.join("/")}`,
    };
  }

  if (!jsonEquals(got, it.value)) {
    return {
      ok: false,
      code: 409,
      reason: "TEST_FAILED",
      message: `test failed at /${it.path.join("/")}`,
      path: `/${it.path.join("/")}`,
    };
  }

  return null;
}

function applyObjSet(
  head: Doc,
  it: Extract<IntentOp, { t: "ObjSet" }>,
  newDot: () => Dot,
): ApplyResult | null {
  if (it.path.length === 0 && it.key === ROOT_KEY) {
    head.root = nodeFromJson(it.value, newDot);
    return null;
  }

  const parentRes = getObjAtPathStrict(head, it.path);
  if (!parentRes.ok) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: parentRes.message,
      path: `/${it.path.join("/")}`,
    };
  }

  if (it.mode === "replace" && !parentRes.obj.entries.has(it.key)) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `no value at /${[...it.path, it.key].join("/")}`,
      path: `/${[...it.path, it.key].join("/")}`,
    };
  }

  const d = newDot();
  const parentObj = parentRes.obj;
  objSet(parentObj, it.key, nodeFromJson(it.value, newDot), d);
  return null;
}

function applyObjRemove(
  head: Doc,
  it: Extract<IntentOp, { t: "ObjRemove" }>,
  newDot: () => Dot,
): ApplyResult | null {
  const parentRes = getObjAtPathStrict(head, it.path);
  if (!parentRes.ok) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: parentRes.message,
      path: `/${it.path.join("/")}`,
    };
  }

  if (!parentRes.obj.entries.has(it.key)) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `no value at /${[...it.path, it.key].join("/")}`,
      path: `/${[...it.path, it.key].join("/")}`,
    };
  }

  const d = newDot();
  const parentObj = parentRes.obj;
  objRemove(parentObj, it.key, d);
  return null;
}

function applyArrInsert(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrInsert" }>,
  newDot: () => Dot,
  bumpCounterAbove?: (ctr: number) => void,
  strictParents = false,
): ApplyResult | null {
  const pointer = `/${it.path.join("/")}`;
  const baseSeq = getSeqAtPath(base, it.path);

  if (!baseSeq) {
    if (strictParents) {
      return {
        ok: false,
        code: 409,
        reason: "MISSING_PARENT",
        message: `base array missing at /${it.path.join("/")}`,
        path: pointer,
      };
    }

    if (it.index === 0 || it.index === Number.POSITIVE_INFINITY) {
      const headSeq = ensureSeqAtPath(head, it.path, newDot());
      const prev =
        it.index === 0 ? HEAD : rgaPrevForInsertAtIndex(headSeq, Number.MAX_SAFE_INTEGER);
      const dotRes = nextInsertDotForPrev(headSeq, prev, newDot, pointer, bumpCounterAbove);
      if (!dotRes.ok) {
        return dotRes;
      }

      const d = dotRes.dot;
      const id = dotToElemId(d);
      rgaInsertAfter(headSeq, prev, id, d, nodeFromJson(it.value, newDot));
      return null;
    }

    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: `base array missing at /${it.path.join("/")}`,
      path: pointer,
    };
  }

  const _d = newDot();
  const headSeqRes = getHeadSeqForBaseArrayIntent(head, it.path);
  if (!headSeqRes.ok) {
    return headSeqRes;
  }
  const headSeq = headSeqRes.seq;
  const idx = it.index === Number.POSITIVE_INFINITY ? rgaLinearizeIds(baseSeq).length : it.index;
  const baseLen = rgaLinearizeIds(baseSeq).length;

  if (idx < 0 || idx > baseLen) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `index out of bounds at /${it.path.join("/")}/${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  const prev = idx === 0 ? HEAD : (rgaIdAtIndex(baseSeq, idx - 1) ?? HEAD);
  const dotRes = nextInsertDotForPrev(headSeq, prev, newDot, pointer, bumpCounterAbove);
  if (!dotRes.ok) {
    return dotRes;
  }

  const d = dotRes.dot;
  const id = dotToElemId(d);
  rgaInsertAfter(headSeq, prev, id, d, nodeFromJson(it.value, newDot));

  return null;
}

function nextInsertDotForPrev(
  seq: RgaSeq,
  prev: ElemId,
  newDot: () => Dot,
  path: string,
  bumpCounterAbove?: (ctr: number) => void,
): { ok: true; dot: Dot } | ApplyError {
  const MAX_INSERT_DOT_ATTEMPTS = 1_024;
  let maxSiblingDot: Dot | null = null;
  for (const elem of seq.elems.values()) {
    if (elem.prev !== prev) {
      continue;
    }

    if (!maxSiblingDot || compareDot(elem.insDot, maxSiblingDot) > 0) {
      maxSiblingDot = elem.insDot;
    }
  }

  if (maxSiblingDot) {
    // Fast-forward external counters so generated dots can stay strictly after
    // existing siblings that share the same predecessor.
    bumpCounterAbove?.(maxSiblingDot.ctr);
  }

  if (!maxSiblingDot) {
    return { ok: true, dot: newDot() };
  }

  // Preserve deterministic "latest insert first" sibling ordering in linearization.
  for (let attempts = 0; attempts < MAX_INSERT_DOT_ATTEMPTS; attempts++) {
    const candidate = newDot();
    if (compareDot(candidate, maxSiblingDot) > 0) {
      return { ok: true, dot: candidate };
    }
  }

  return {
    ok: false,
    code: 409,
    reason: "DOT_GENERATION_EXHAUSTED",
    message: `failed to generate insert dot within ${MAX_INSERT_DOT_ATTEMPTS} attempts`,
    path,
  };
}

function applyArrDelete(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrDelete" }>,
  newDot: () => Dot,
): ApplyResult | null {
  const _d = newDot();
  const baseSeq = getSeqAtPath(base, it.path);

  if (!baseSeq) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: `base array missing at /${it.path.join("/")}`,
      path: `/${it.path.join("/")}`,
    };
  }

  const headSeqRes = getHeadSeqForBaseArrayIntent(head, it.path);
  if (!headSeqRes.ok) {
    return headSeqRes;
  }
  const headSeq = headSeqRes.seq;
  const baseId = rgaIdAtIndex(baseSeq, it.index);

  if (!baseId) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `no base element at index ${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  const e = headSeq.elems.get(baseId);
  if (!e) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `element missing in head lineage at index ${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  rgaDelete(headSeq, baseId);

  return null;
}

function applyArrReplace(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrReplace" }>,
  newDot: () => Dot,
): ApplyResult | null {
  const _d = newDot();
  const baseSeq = getSeqAtPath(base, it.path);

  if (!baseSeq) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: `base array missing at /${it.path.join("/")}`,
      path: `/${it.path.join("/")}`,
    };
  }

  const headSeqRes = getHeadSeqForBaseArrayIntent(head, it.path);
  if (!headSeqRes.ok) {
    return headSeqRes;
  }
  const headSeq = headSeqRes.seq;
  const baseId = rgaIdAtIndex(baseSeq, it.index);

  if (!baseId) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `no base element at index ${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  const e = headSeq.elems.get(baseId);

  if (!e || e.tombstone) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `element already deleted at index ${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  e.value = nodeFromJson(it.value, newDot);

  return null;
}

// ── Main dispatcher ─────────────────────────────────────────────────

/**
 * Apply compiled intent operations to a CRDT document.
 * Array indices are resolved against the base document.
 * @param base - The base document snapshot used for index mapping and test evaluation.
 * @param head - The target document to mutate.
 * @param intents - Compiled intent operations from `compileJsonPatchToIntent`.
 * @param newDot - A function that generates a unique `Dot` per mutation.
 * @param evalTestAgainst - Whether `test` ops are evaluated against `"head"` or `"base"`.
 * @param bumpCounterAbove - Optional hook that can fast-forward the underlying counter before inserts.
 * @param options - Optional behavior toggles.
 * @param options.strictParents - When `true`, reject array inserts whose base parent path is missing.
 * @returns `{ ok: true }` on success, or `{ ok: false, code: 409, message }` on conflict.
 */
export function applyIntentsToCrdt(
  base: Doc,
  head: Doc,
  intents: IntentOp[],
  newDot: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
  options: { strictParents?: boolean } = {},
): ApplyResult {
  for (const it of intents) {
    let fail: ApplyResult | null = null;

    switch (it.t) {
      case "Test":
        fail = applyTest(base, head, it, evalTestAgainst);
        break;
      case "ObjSet":
        fail = applyObjSet(head, it, newDot);
        break;
      case "ObjRemove":
        fail = applyObjRemove(head, it, newDot);
        break;
      case "ArrInsert":
        fail = applyArrInsert(
          base,
          head,
          it,
          newDot,
          bumpCounterAbove,
          options.strictParents ?? false,
        );
        break;
      case "ArrDelete":
        fail = applyArrDelete(base, head, it, newDot);
        break;
      case "ArrReplace":
        fail = applyArrReplace(base, head, it, newDot);
        break;
      default:
        assertNever(it, "Unhandled intent type");
    }

    if (fail) return fail;
  }

  return { ok: true };
}

/**
 * Convenience wrapper: compile a JSON Patch and apply it to a CRDT document.
 * Overloads:
 * - positional:
 *   `jsonPatchToCrdt(base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?, strictParents?)`
 * - object:
 *   `jsonPatchToCrdt({ base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?, semantics?, strictParents? })`
 */
export function jsonPatchToCrdt(options: JsonPatchToCrdtOptions): ApplyResult;
export function jsonPatchToCrdt(
  base: Doc,
  head: Doc,
  patch: JsonPatchOp[],
  newDot: () => Dot,
  evalTestAgainst?: "head" | "base",
  bumpCounterAbove?: (ctr: number) => void,
  strictParents?: boolean,
): ApplyResult;
export function jsonPatchToCrdt(
  baseOrOptions: Doc | JsonPatchToCrdtOptions,
  head?: Doc,
  patch?: JsonPatchOp[],
  newDot?: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
  strictParents = false,
): ApplyResult {
  if (isJsonPatchToCrdtOptions(baseOrOptions)) {
    return jsonPatchToCrdtInternal(baseOrOptions);
  }

  if (!head || !patch || !newDot) {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_PATCH",
      message: "invalid jsonPatchToCrdt call signature",
    };
  }

  return jsonPatchToCrdtInternal({
    base: baseOrOptions,
    head,
    patch,
    newDot,
    evalTestAgainst,
    bumpCounterAbove,
    strictParents,
  });
}

/**
 * Safe wrapper around `jsonPatchToCrdt`.
 * This function never throws and always returns an `ApplyResult`.
 */
export function jsonPatchToCrdtSafe(options: JsonPatchToCrdtOptions): ApplyResult;
export function jsonPatchToCrdtSafe(
  base: Doc,
  head: Doc,
  patch: JsonPatchOp[],
  newDot: () => Dot,
  evalTestAgainst?: "head" | "base",
  bumpCounterAbove?: (ctr: number) => void,
  strictParents?: boolean,
): ApplyResult;
export function jsonPatchToCrdtSafe(
  baseOrOptions: Doc | JsonPatchToCrdtOptions,
  head?: Doc,
  patch?: JsonPatchOp[],
  newDot?: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
  strictParents = false,
): ApplyResult {
  try {
    if (isJsonPatchToCrdtOptions(baseOrOptions)) {
      return jsonPatchToCrdt(baseOrOptions);
    }

    if (!head || !patch || !newDot) {
      return {
        ok: false,
        code: 409,
        reason: "INVALID_PATCH",
        message: "invalid jsonPatchToCrdtSafe call signature",
      };
    }

    return jsonPatchToCrdt(
      baseOrOptions,
      head,
      patch,
      newDot,
      evalTestAgainst,
      bumpCounterAbove,
      strictParents,
    );
  } catch (error) {
    return toApplyError(error);
  }
}

/** Alias for codebases that prefer `try*` naming for non-throwing APIs. */
export const tryJsonPatchToCrdt = jsonPatchToCrdtSafe;

/**
 * Generate a JSON Patch delta between two CRDT documents.
 * @param base - The base document snapshot.
 * @param head - The current document state.
 * @param options - Diff options (e.g. `{ arrayStrategy: "lcs" }`).
 * @returns An array of JSON Patch operations that transform base into head.
 */
export function crdtToJsonPatch(base: Doc, head: Doc, options?: DiffOptions): JsonPatchOp[] {
  return diffJsonPatch(materialize(base.root), materialize(head.root), options);
}

/**
 * Emit a single root `replace` patch representing the full document state.
 * Use `crdtToJsonPatch(base, head)` for delta patches instead.
 */
export function crdtToFullReplace(doc: Doc): JsonPatchOp[] {
  return [{ op: "replace", path: "", value: materialize(doc.root) }];
}

function jsonPatchToCrdtInternal(options: JsonPatchToCrdtOptions): ApplyResult {
  const evalTestAgainst = options.evalTestAgainst ?? "head";
  const semantics = options.semantics ?? "sequential";

  if (semantics === "base") {
    const baseJson = materialize(options.base.root);
    let intents: IntentOp[];
    try {
      intents = compileJsonPatchToIntent(baseJson, options.patch, {
        semantics: "base",
      });
    } catch (error) {
      return toApplyError(error);
    }

    return applyIntentsToCrdt(
      options.base,
      options.head,
      intents,
      options.newDot,
      evalTestAgainst,
      options.bumpCounterAbove,
      { strictParents: options.strictParents },
    );
  }

  // Sequential mode compiles each op against a rolling snapshot. `shadowBase`
  // tracks that compile-time view without mutating caller-provided `base`.
  let shadowBase = cloneDoc(evalTestAgainst === "base" ? options.base : options.head);
  let shadowCtr = 0;
  const shadowDot = () => ({ actor: "__shadow__", ctr: ++shadowCtr });
  const shadowBump = (ctr: number) => {
    if (shadowCtr < ctr) {
      shadowCtr = ctr;
    }
  };

  const applySequentialOp = (op: JsonPatchOp, opIndex: number): ApplyResult => {
    const baseJson = materialize(shadowBase.root);
    let intents: IntentOp[];
    try {
      intents = compileJsonPatchToIntent(baseJson, [op], {
        semantics: "sequential",
      });
    } catch (error) {
      return withOpIndex(toApplyError(error), opIndex);
    }

    const headStep = applyIntentsToCrdt(
      shadowBase,
      options.head,
      intents,
      options.newDot,
      evalTestAgainst,
      options.bumpCounterAbove,
      { strictParents: options.strictParents },
    );
    if (!headStep.ok) {
      return withOpIndex(headStep, opIndex);
    }

    if (evalTestAgainst === "base") {
      // Keep the compile-time base in lockstep for future operations while using
      // synthetic dots so we do not consume real actor counters.
      const shadowStep = applyIntentsToCrdt(
        shadowBase,
        shadowBase,
        intents,
        shadowDot,
        "base",
        shadowBump,
        { strictParents: options.strictParents },
      );
      if (!shadowStep.ok) {
        return withOpIndex(shadowStep, opIndex);
      }
    } else {
      shadowBase = cloneDoc(options.head);
    }

    return { ok: true };
  };

  for (let opIndex = 0; opIndex < options.patch.length; opIndex++) {
    const op = options.patch[opIndex]!;
    if (op.op === "move") {
      const baseJson = materialize(shadowBase.root);
      let fromValue: JsonValue;
      try {
        // Read the source before applying remove so move behaves as "copy then remove".
        fromValue = structuredClone(getAtJson(baseJson, parseJsonPointer(op.from)));
      } catch {
        try {
          compileJsonPatchToIntent(baseJson, [{ op: "remove", path: op.from }], {
            semantics: "sequential",
          });
        } catch (error) {
          return withOpIndex(toApplyError(error), opIndex);
        }

        return withOpIndex(
          toApplyError(new Error(`failed to resolve move source at ${op.from}`)),
          opIndex,
        );
      }

      if (op.from === op.path) {
        continue;
      }

      const removeStep = applySequentialOp({ op: "remove", path: op.from }, opIndex);
      if (!removeStep.ok) {
        return removeStep;
      }

      const addStep = applySequentialOp({ op: "add", path: op.path, value: fromValue }, opIndex);
      if (!addStep.ok) {
        return addStep;
      }

      continue;
    }

    const step = applySequentialOp(op, opIndex);
    if (!step.ok) {
      return step;
    }
  }

  return { ok: true };
}

function withOpIndex(error: ApplyError, opIndex: number): ApplyError {
  if (error.opIndex !== undefined) {
    return error;
  }

  return { ...error, opIndex };
}

function isJsonPatchToCrdtOptions(value: unknown): value is JsonPatchToCrdtOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    "base" in value &&
    "head" in value &&
    "patch" in value &&
    "newDot" in value
  );
}

function toApplyError(error: unknown): ApplyError {
  if (error instanceof TraversalDepthError) {
    return toDepthApplyError(error);
  }

  if (error instanceof PatchCompileError) {
    return {
      ok: false,
      code: 409,
      reason: error.reason,
      message: error.message,
      path: error.path,
      opIndex: error.opIndex,
    };
  }

  return {
    ok: false,
    code: 409,
    reason: "INVALID_PATCH",
    message: error instanceof Error ? error.message : "failed to compile/apply patch",
  };
}

function assertNever(_value: never, message: string): never {
  throw new Error(message);
}
