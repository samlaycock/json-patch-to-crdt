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
  ARRAY_INDEX_TOKEN_PATTERN,
  PatchCompileError,
  compileJsonPatchToIntent,
  diffJsonPatch,
  jsonEquals,
  parseJsonPointer,
  stringifyJsonPointer,
} from "./patch";
import {
  HEAD,
  rgaCreateLinearCursor,
  rgaCreateIndexedIdSnapshot,
  rgaDelete,
  rgaIdAtIndex,
  rgaInsertAfter,
  rgaLength,
  rgaMaxInsertDotForPrev,
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
 * Legacy helper for tests and fixtures that seeds an entire document from one dot.
 *
 * It reuses that dot for object entries and synthesizes array child counters from the
 * same seed, which can produce low-quality causal metadata and unrealistic sequence
 * identities in production CRDT state.
 *
 * Prefer `docFromJson(value, nextDot)` so every node receives a fresh unique dot.
 *
 * @deprecated Use `docFromJson(value, nextDot)` for production documents.
 */
export function docFromJsonWithDot(value: JsonValue, dot: Dot): Doc {
  return { root: deepNodeFromJson(value, dot) };
}

function getSeqAtPath(doc: Doc, path: string[]): RgaSeq | undefined {
  const node = getNodeAtPath(doc, path);
  return node?.kind === "seq" ? node : undefined;
}

function getObjAtPathStrict(
  doc: Doc,
  path: string[],
): { ok: true; obj: ObjNode } | { ok: false; message: string } {
  const node = getNodeAtPath(doc, path);
  if (!node || node.kind !== "obj") {
    const pointer = stringifyJsonPointer(path);
    return { ok: false, message: `expected object at ${pointer === "" ? "/" : pointer}` };
  }

  return { ok: true, obj: node };
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
    if (cur.kind === "obj") {
      const ent = cur.entries.get(seg);
      if (!ent) {
        return undefined;
      }

      cur = ent.node;
      continue;
    }

    if (cur.kind === "seq") {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(seg)) {
        return undefined;
      }

      const index = Number(seg);
      if (!Number.isSafeInteger(index)) {
        return undefined;
      }

      const elemId = rgaIdAtIndex(cur, index);
      if (elemId === undefined) {
        return undefined;
      }

      const elem = cur.elems.get(elemId);
      if (!elem) {
        return undefined;
      }

      cur = elem.value;
      continue;
    }

    if (cur.kind === "lww") {
      return undefined;
    }
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
      delDot: e.delDot ? { actor: e.delDot.actor, ctr: e.delDot.ctr } : undefined,
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

function getJsonAtDocPathForTest(
  doc: Doc,
  path: string[],
): { ok: true; value: JsonValue } | { ok: false; error: ApplyError } {
  let cur: Node = doc.root;

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    try {
      assertTraversalDepth(i + 1);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof TraversalDepthError
            ? toDepthApplyError(error)
            : {
                ok: false,
                code: 409,
                reason: "INVALID_PATCH",
                message: error instanceof Error ? error.message : "invalid test path",
              },
      };
    }

    if (cur.kind === "obj") {
      const ent = cur.entries.get(seg);
      if (!ent) {
        return {
          ok: false,
          error: {
            ok: false,
            code: 409,
            reason: "MISSING_TARGET",
            message: `Missing key '${seg}'`,
          },
        };
      }

      cur = ent.node;
      continue;
    }

    if (cur.kind === "seq") {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(seg)) {
        return {
          ok: false,
          error: {
            ok: false,
            code: 409,
            reason: "INVALID_POINTER",
            message: `Expected array index, got '${seg}'`,
          },
        };
      }

      const idx = Number(seg);
      if (!Number.isSafeInteger(idx)) {
        return {
          ok: false,
          error: {
            ok: false,
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${seg}'`,
          },
        };
      }

      const id = rgaIdAtIndex(cur, idx);
      if (id === undefined) {
        return {
          ok: false,
          error: {
            ok: false,
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${seg}'`,
          },
        };
      }

      cur = cur.elems.get(id)!.value;
      continue;
    }

    return {
      ok: false,
      error: {
        ok: false,
        code: 409,
        reason: "INVALID_TARGET",
        message: `Cannot traverse into non-container at '${seg}'`,
      },
    };
  }

  return { ok: true, value: cur.kind === "lww" ? cur.value : materialize(cur) };
}

// ── Per-intent handlers ─────────────────────────────────────────────

function applyTest(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "Test" }>,
  evalTestAgainst: "head" | "base",
): ApplyResult | null {
  const targetDoc = evalTestAgainst === "head" ? head : base;
  const got = getJsonAtDocPathForTest(targetDoc, it.path);
  if (!got.ok) {
    return {
      ...got.error,
      path: `/${it.path.join("/")}`,
    };
  }

  if (!jsonEquals(got.value, it.value)) {
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

type ArrayIndexLookupSession = {
  get: (seq: RgaSeq) => ReturnType<typeof rgaCreateIndexedIdSnapshot>;
};

function createArrayIndexLookupSession(): ArrayIndexLookupSession {
  const bySeq = new WeakMap<RgaSeq, ReturnType<typeof rgaCreateIndexedIdSnapshot>>();

  return {
    get(seq) {
      const cached = bySeq.get(seq);
      if (cached) {
        return cached;
      }

      const created = rgaCreateIndexedIdSnapshot(seq);
      bySeq.set(seq, created);
      return created;
    },
  };
}

function applyArrInsert(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrInsert" }>,
  newDot: () => Dot,
  indexSession: ArrayIndexLookupSession,
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
  const baseIndex = indexSession.get(baseSeq);
  const baseLen = baseIndex.length();
  const idx = it.index === Number.POSITIVE_INFINITY ? baseLen : it.index;

  if (idx < 0 || idx > baseLen) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `index out of bounds at /${it.path.join("/")}/${it.index}`,
      path: `/${it.path.join("/")}/${it.index}`,
    };
  }

  const prev = baseIndex.prevForInsertAt(idx);
  const dotRes = nextInsertDotForPrev(headSeq, prev, newDot, pointer, bumpCounterAbove);
  if (!dotRes.ok) {
    return dotRes;
  }

  const d = dotRes.dot;
  const id = dotToElemId(d);
  rgaInsertAfter(headSeq, prev, id, d, nodeFromJson(it.value, newDot));
  if (baseSeq === headSeq) {
    baseIndex.insertAt(idx, id);
  }

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
  const maxSiblingDot = rgaMaxInsertDotForPrev(seq, prev);

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
  indexSession: ArrayIndexLookupSession,
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
  const baseIndex = indexSession.get(baseSeq);
  const baseId = baseIndex.idAt(it.index);

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

  rgaDelete(headSeq, baseId, _d);
  if (baseSeq === headSeq) {
    baseIndex.deleteAt(it.index);
  }

  return null;
}

function applyArrReplace(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrReplace" }>,
  newDot: () => Dot,
  indexSession: ArrayIndexLookupSession,
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
  const baseIndex = indexSession.get(baseSeq);
  const baseId = baseIndex.idAt(it.index);

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
  const arrayIndexSession = createArrayIndexLookupSession();

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
          arrayIndexSession,
          bumpCounterAbove,
          options.strictParents ?? false,
        );
        break;
      case "ArrDelete":
        fail = applyArrDelete(base, head, it, newDot, arrayIndexSession);
        break;
      case "ArrReplace":
        fail = applyArrReplace(base, head, it, newDot, arrayIndexSession);
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

function nodeToJsonForPatch(node: Node): JsonValue {
  // Materialization intentionally restarts depth from 0 here: traversal guards
  // already bound recursive diff walks, and resetting avoids false depth errors
  // when emitting add/replace payloads for deep but non-cyclic subtrees.
  return node.kind === "lww" ? node.value : materialize(node);
}

function rebaseDiffOps(path: string[], nestedOps: JsonPatchOp[], out: JsonPatchOp[]): void {
  const prefix = stringifyJsonPointer(path);

  for (const op of nestedOps) {
    const rebasedPath = prefix === "" ? op.path : op.path === "" ? prefix : `${prefix}${op.path}`;

    if (op.op === "remove") {
      out.push({ op: "remove", path: rebasedPath });
      continue;
    }

    if (op.op === "add" || op.op === "replace") {
      out.push({
        op: op.op,
        path: rebasedPath,
        value: op.value,
      });
      continue;
    }

    throw new Error(`Unexpected op '${op.op}' from diffJsonPatch`);
  }
}

function collectLiveSequenceElements(seq: RgaSeq): RgaElem[] {
  const elems: RgaElem[] = [];
  const cursor = rgaCreateLinearCursor(seq);

  for (let elem = cursor.next(); elem; elem = cursor.next()) {
    elems.push(elem);
  }

  return elems;
}

function materializeSequenceWindow(
  elems: readonly RgaElem[],
  start: number,
  end: number,
): JsonValue[] {
  const out: JsonValue[] = [];

  for (let i = start; i < end; i++) {
    out.push(nodeToJsonForPatch(elems[i]!.value));
  }

  return out;
}

function rebaseSequenceWindowDiffOps(
  path: string[],
  indexOffset: number,
  nestedOps: JsonPatchOp[],
  out: JsonPatchOp[],
): boolean {
  const pending: JsonPatchOp[] = [];

  for (const op of nestedOps) {
    if (op.path === "") {
      return false;
    }

    const rebasedSegments = parseJsonPointer(op.path);
    const indexToken = rebasedSegments[0];
    if (!indexToken || !ARRAY_INDEX_TOKEN_PATTERN.test(indexToken)) {
      return false;
    }

    rebasedSegments[0] = String(Number(indexToken) + indexOffset);
    const rebasedPath = stringifyJsonPointer([...path, ...rebasedSegments]);

    if (op.op === "remove") {
      pending.push({ op: "remove", path: rebasedPath });
      continue;
    }

    if (op.op === "add" || op.op === "replace") {
      pending.push({
        op: op.op,
        path: rebasedPath,
        value: op.value,
      });
      continue;
    }

    return false;
  }

  out.push(...pending);
  return true;
}

function nodesJsonEqual(baseNode: Node, headNode: Node, depth: number): boolean {
  assertTraversalDepth(depth);

  if (baseNode === headNode) {
    return true;
  }

  if (baseNode.kind !== headNode.kind) {
    return false;
  }

  if (baseNode.kind === "lww") {
    const headLww = headNode as typeof baseNode;
    return jsonEquals(baseNode.value, headLww.value);
  }

  if (baseNode.kind === "obj") {
    const headObj = headNode as ObjNode;

    if (baseNode.entries.size !== headObj.entries.size) {
      return false;
    }

    for (const [key, baseEntry] of baseNode.entries.entries()) {
      const headEntry = headObj.entries.get(key);
      if (!headEntry) {
        return false;
      }

      if (!nodesJsonEqual(baseEntry.node, headEntry.node, depth + 1)) {
        return false;
      }
    }

    return true;
  }

  // This deep equality check can cost one extra sequence walk for non-identical
  // but equal arrays, in exchange for skipping materialization when equal.
  const headSeq = headNode as RgaSeq;
  const baseCursor = rgaCreateLinearCursor(baseNode);
  const headCursor = rgaCreateLinearCursor(headSeq);

  while (true) {
    const baseElem = baseCursor.next();
    const headElem = headCursor.next();
    if (baseElem === undefined || headElem === undefined) {
      return baseElem === undefined && headElem === undefined;
    }

    if (!nodesJsonEqual(baseElem.value, headElem.value, depth + 1)) {
      return false;
    }
  }
}

function diffObjectNodes(
  path: string[],
  baseNode: ObjNode,
  headNode: ObjNode,
  options: DiffOptions,
  ops: JsonPatchOp[],
  depth: number,
): void {
  assertTraversalDepth(depth);

  const baseKeys = [...baseNode.entries.keys()].sort();
  const headKeys = [...headNode.entries.keys()].sort();

  let baseIndex = 0;
  let headIndex = 0;

  while (baseIndex < baseKeys.length && headIndex < headKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const headKey = headKeys[headIndex]!;

    if (baseKey === headKey) {
      baseIndex += 1;
      headIndex += 1;
      continue;
    }

    if (baseKey < headKey) {
      path.push(baseKey);
      ops.push({ op: "remove", path: stringifyJsonPointer(path) });
      path.pop();
      baseIndex += 1;
      continue;
    }

    headIndex += 1;
  }

  while (baseIndex < baseKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    path.push(baseKey);
    ops.push({ op: "remove", path: stringifyJsonPointer(path) });
    path.pop();
    baseIndex += 1;
  }

  baseIndex = 0;
  headIndex = 0;
  while (baseIndex < baseKeys.length && headIndex < headKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const headKey = headKeys[headIndex]!;

    if (baseKey === headKey) {
      baseIndex += 1;
      headIndex += 1;
      continue;
    }

    if (baseKey < headKey) {
      baseIndex += 1;
      continue;
    }

    const headEntry = headNode.entries.get(headKey)!;
    path.push(headKey);
    ops.push({
      op: "add",
      path: stringifyJsonPointer(path),
      value: nodeToJsonForPatch(headEntry.node),
    });
    path.pop();
    headIndex += 1;
  }

  while (headIndex < headKeys.length) {
    const headKey = headKeys[headIndex]!;
    const headEntry = headNode.entries.get(headKey)!;
    path.push(headKey);
    ops.push({
      op: "add",
      path: stringifyJsonPointer(path),
      value: nodeToJsonForPatch(headEntry.node),
    });
    path.pop();
    headIndex += 1;
  }

  baseIndex = 0;
  headIndex = 0;
  while (baseIndex < baseKeys.length && headIndex < headKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const headKey = headKeys[headIndex]!;

    if (baseKey === headKey) {
      const baseEntry = baseNode.entries.get(baseKey)!;
      const headEntry = headNode.entries.get(headKey)!;
      if (!nodesJsonEqual(baseEntry.node, headEntry.node, depth + 1)) {
        path.push(baseKey);
        diffNodeToPatch(path, baseEntry.node, headEntry.node, options, ops, depth + 1);
        path.pop();
      }
      baseIndex += 1;
      headIndex += 1;
      continue;
    }

    if (baseKey < headKey) {
      baseIndex += 1;
      continue;
    }

    headIndex += 1;
  }
}

function diffSequenceNodes(
  path: string[],
  baseNode: RgaSeq,
  headSeq: RgaSeq,
  options: DiffOptions,
  ops: JsonPatchOp[],
  depth: number,
): void {
  const arrayStrategy = options.arrayStrategy ?? "lcs";
  if (arrayStrategy === "atomic") {
    const seqOps = diffJsonPatch(materialize(baseNode), materialize(headSeq), options);
    rebaseDiffOps(path, seqOps, ops);
    return;
  }

  const baseElems = collectLiveSequenceElements(baseNode);
  const headElems = collectLiveSequenceElements(headSeq);
  const sharedLength = Math.min(baseElems.length, headElems.length);

  let prefixLength = 0;
  while (
    prefixLength < sharedLength &&
    nodesJsonEqual(baseElems[prefixLength]!.value, headElems[prefixLength]!.value, depth + 1)
  ) {
    prefixLength += 1;
  }

  if (prefixLength === baseElems.length && prefixLength === headElems.length) {
    return;
  }

  let baseEnd = baseElems.length;
  let headEnd = headElems.length;
  while (
    baseEnd > prefixLength &&
    headEnd > prefixLength &&
    nodesJsonEqual(baseElems[baseEnd - 1]!.value, headElems[headEnd - 1]!.value, depth + 1)
  ) {
    baseEnd -= 1;
    headEnd -= 1;
  }

  const unmatchedBaseLength = baseEnd - prefixLength;
  const unmatchedHeadLength = headEnd - prefixLength;
  if (unmatchedBaseLength === 1 && unmatchedHeadLength === 1) {
    path.push(String(prefixLength));
    diffNodeToPatch(
      path,
      baseElems[prefixLength]!.value,
      headElems[prefixLength]!.value,
      options,
      ops,
      depth + 1,
    );
    path.pop();
    return;
  }

  const baseWindow = materializeSequenceWindow(baseElems, prefixLength, baseEnd);
  const headWindow = materializeSequenceWindow(headElems, prefixLength, headEnd);
  const seqOps = diffJsonPatch(baseWindow, headWindow, options);
  if (rebaseSequenceWindowDiffOps(path, prefixLength, seqOps, ops)) {
    return;
  }

  const fallbackSeqOps = diffJsonPatch(materialize(baseNode), materialize(headSeq), options);
  rebaseDiffOps(path, fallbackSeqOps, ops);
}

function diffNodeToPatch(
  path: string[],
  baseNode: Node,
  headNode: Node,
  options: DiffOptions,
  ops: JsonPatchOp[],
  depth: number,
): void {
  assertTraversalDepth(depth);

  if (baseNode === headNode) {
    return;
  }

  if (baseNode.kind !== headNode.kind) {
    ops.push({
      op: "replace",
      path: stringifyJsonPointer(path),
      value: nodeToJsonForPatch(headNode),
    });
    return;
  }

  if (baseNode.kind === "lww") {
    const headLww = headNode as typeof baseNode;

    // Object diff pass 3 may have already compared these leaves to skip equal subtrees.
    // Re-checking here keeps direct/root LWW diffs self-contained without materialization.
    if (jsonEquals(baseNode.value, headLww.value)) {
      return;
    }

    ops.push({
      op: "replace",
      path: stringifyJsonPointer(path),
      value: headLww.value,
    });
    return;
  }

  if (baseNode.kind === "obj") {
    diffObjectNodes(path, baseNode, headNode as ObjNode, options, ops, depth);
    return;
  }

  diffSequenceNodes(path, baseNode as RgaSeq, headNode as RgaSeq, options, ops, depth);
}

/**
 * Generate a JSON Patch delta between two CRDT documents.
 * @param base - The base document snapshot.
 * @param head - The current document state.
 * @param options - Diff options (e.g. `{ arrayStrategy: "lcs" }` or `{ arrayStrategy: "lcs-linear" }`).
 * @returns An array of JSON Patch operations that transform base into head.
 */
export function crdtToJsonPatch(base: Doc, head: Doc, options?: DiffOptions): JsonPatchOp[] {
  // Preserve full-document runtime guardrail behavior for strict/normalize modes.
  if ((options?.jsonValidation ?? "none") !== "none") {
    return diffJsonPatch(materialize(base.root), materialize(head.root), options);
  }

  return crdtNodesToJsonPatch(base.root, head.root, options);
}

/** Internals-only helper for diffing CRDT nodes from an existing traversal depth. */
export function crdtNodesToJsonPatch(
  baseNode: Node,
  headNode: Node,
  options?: DiffOptions,
  depth = 0,
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  diffNodeToPatch([], baseNode, headNode, options ?? {}, ops, depth);
  return ops;
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
  const shadowBase = evalTestAgainst === "base" ? cloneDoc(options.base) : null;
  let shadowCtr = 0;
  const shadowDot = () => ({ actor: "__shadow__", ctr: ++shadowCtr });
  const shadowBump = (ctr: number) => {
    if (shadowCtr < ctr) {
      shadowCtr = ctr;
    }
  };

  const session: SequentialCompileSession = {
    pointerCache: new Map(),
  };

  for (const [opIndex, op] of options.patch.entries()) {
    const compileBase = evalTestAgainst === "base" ? shadowBase! : options.head;
    const step = applySequentialPatchOp(
      options,
      compileBase,
      op,
      opIndex,
      evalTestAgainst,
      shadowDot,
      shadowBump,
      session,
    );
    if (!step.ok) {
      return step;
    }
  }

  return { ok: true };
}

type SequentialCompileSession = {
  pointerCache: Map<string, string[]>;
};

function applySequentialPatchOp(
  options: JsonPatchToCrdtOptions,
  compileBase: Doc,
  op: JsonPatchOp,
  opIndex: number,
  evalTestAgainst: "head" | "base",
  shadowDot: () => Dot,
  shadowBump: (ctr: number) => void,
  session: SequentialCompileSession,
): ApplyResult {
  if (op.op === "move") {
    if (op.from === op.path) {
      const pathCheck = resolveValueAtPointerInDoc(
        compileBase,
        op.from,
        opIndex,
        session.pointerCache,
      );
      if (!pathCheck.ok) {
        return pathCheck;
      }

      return { ok: true };
    }

    const fromResolved = resolveValueAtPointerInDoc(
      compileBase,
      op.from,
      opIndex,
      session.pointerCache,
    );
    if (!fromResolved.ok) {
      return fromResolved;
    }

    const removeStep = applySingleSequentialPatchStep(
      options,
      compileBase,
      { op: "remove", path: op.from },
      opIndex,
      evalTestAgainst,
      shadowDot,
      shadowBump,
      session,
    );
    if (!removeStep.ok) {
      return removeStep;
    }

    return applySingleSequentialPatchStep(
      options,
      compileBase,
      { op: "add", path: op.path, value: structuredClone(fromResolved.value) },
      opIndex,
      evalTestAgainst,
      shadowDot,
      shadowBump,
      session,
    );
  }

  if (op.op === "copy") {
    const fromResolved = resolveValueAtPointerInDoc(
      compileBase,
      op.from,
      opIndex,
      session.pointerCache,
    );
    if (!fromResolved.ok) {
      return fromResolved;
    }

    return applySingleSequentialPatchStep(
      options,
      compileBase,
      { op: "add", path: op.path, value: structuredClone(fromResolved.value) },
      opIndex,
      evalTestAgainst,
      shadowDot,
      shadowBump,
      session,
    );
  }

  return applySingleSequentialPatchStep(
    options,
    compileBase,
    op,
    opIndex,
    evalTestAgainst,
    shadowDot,
    shadowBump,
    session,
  );
}

function applySingleSequentialPatchStep(
  options: JsonPatchToCrdtOptions,
  compileBase: Doc,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  opIndex: number,
  evalTestAgainst: "head" | "base",
  shadowDot: () => Dot,
  shadowBump: (ctr: number) => void,
  session: SequentialCompileSession,
): ApplyResult {
  const compiled = compilePreparedSingleIntentFromDoc(
    compileBase,
    op,
    session.pointerCache,
    opIndex,
  );
  if (!compiled.ok) {
    return compiled;
  }

  const headStep = applyIntentsToCrdt(
    compileBase,
    options.head,
    compiled.intents,
    options.newDot,
    evalTestAgainst,
    options.bumpCounterAbove,
    { strictParents: options.strictParents },
  );
  if (!headStep.ok) {
    return withOpIndex(headStep, opIndex);
  }

  if (op.op === "test") {
    return { ok: true };
  }

  if (evalTestAgainst === "head") {
    return { ok: true };
  }

  const shadowStep = applyIntentsToCrdt(
    compileBase,
    compileBase,
    compiled.intents,
    shadowDot,
    "base",
    shadowBump,
    { strictParents: options.strictParents },
  );
  if (!shadowStep.ok) {
    return withOpIndex(shadowStep, opIndex);
  }

  return { ok: true };
}

function resolveValueAtPointerInDoc(
  doc: Doc,
  pointer: string,
  opIndex: number,
  pointerCache: Map<string, string[]>,
): { ok: true; value: JsonValue } | ApplyError {
  const parsedPath = parsePointerWithCache(pointer, pointerCache, opIndex);
  if (!parsedPath.ok) {
    return parsedPath;
  }

  const resolved = resolveNodeAtPath(doc.root, parsedPath.path);
  if (!resolved.ok) {
    return {
      ok: false,
      ...resolved.error,
      path: pointer,
      opIndex,
    };
  }

  return {
    ok: true,
    value: nodeToJsonForPatch(resolved.node),
  };
}

function compilePreparedSingleIntentFromDoc(
  baseDoc: Doc,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  pointerCache: Map<string, string[]>,
  opIndex: number,
): { ok: true; intents: IntentOp[] } | ApplyError {
  const parsedPath = parsePointerWithCache(op.path, pointerCache, opIndex);
  if (!parsedPath.ok) {
    return parsedPath;
  }

  const path = parsedPath.path;
  if (op.op === "test") {
    return {
      ok: true,
      intents: [{ t: "Test", path, value: op.value }],
    };
  }

  if (path.length === 0) {
    if (op.op === "remove") {
      return {
        ok: false,
        code: 409,
        reason: "INVALID_TARGET",
        message: "remove at root path is not supported in RFC-compliant mode",
        path: op.path,
        opIndex,
      };
    }

    return {
      ok: true,
      intents: [{ t: "ObjSet", path: [], key: ROOT_KEY, value: op.value }],
    };
  }

  const parentPath = path.slice(0, -1);
  const parentPointer = stringifyJsonPointer(parentPath);
  const key = path[path.length - 1]!;
  const resolvedParent =
    parentPath.length === 0
      ? { ok: true as const, node: baseDoc.root }
      : resolveNodeAtPath(baseDoc.root, parentPath);
  if (!resolvedParent.ok) {
    return {
      ok: false,
      ...resolvedParent.error,
      path: parentPointer,
      opIndex,
    };
  }

  const parentNode = resolvedParent.node;
  if (parentNode.kind === "seq") {
    const parsedIndex = parseArrayIndexTokenForDoc(key, op.op, op.path, opIndex);
    if (!parsedIndex.ok) {
      return parsedIndex;
    }

    const boundedIndex = validateArrayIndexBounds(
      parsedIndex.index,
      op.op,
      rgaLength(parentNode),
      op.path,
      opIndex,
    );
    if (!boundedIndex.ok) {
      return boundedIndex;
    }

    if (op.op === "add") {
      return {
        ok: true,
        intents: [{ t: "ArrInsert", path: parentPath, index: boundedIndex.index, value: op.value }],
      };
    }

    if (op.op === "remove") {
      return {
        ok: true,
        intents: [{ t: "ArrDelete", path: parentPath, index: boundedIndex.index }],
      };
    }

    return {
      ok: true,
      intents: [{ t: "ArrReplace", path: parentPath, index: boundedIndex.index, value: op.value }],
    };
  }

  if (parentNode.kind !== "obj") {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_TARGET",
      message: `expected object or array parent at ${parentPointer}`,
      path: parentPointer,
      opIndex,
    };
  }

  if (key === "__proto__") {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_POINTER",
      message: `unsafe object key at ${op.path}`,
      path: op.path,
      opIndex,
    };
  }

  const entry = parentNode.entries.get(key);
  if ((op.op === "replace" || op.op === "remove") && !entry) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `missing key ${key} at ${parentPointer}`,
      path: op.path,
      opIndex,
    };
  }

  if (op.op === "remove") {
    return {
      ok: true,
      intents: [{ t: "ObjRemove", path: parentPath, key }],
    };
  }

  return {
    ok: true,
    intents: [{ t: "ObjSet", path: parentPath, key, value: op.value, mode: op.op }],
  };
}

function parsePointerWithCache(
  pointer: string,
  pointerCache: Map<string, string[]>,
  opIndex: number,
): { ok: true; path: string[] } | ApplyError {
  const cachedPath = pointerCache.get(pointer);
  if (cachedPath !== undefined) {
    return { ok: true, path: cachedPath.slice() };
  }

  try {
    const parsedPath = parseJsonPointer(pointer);
    pointerCache.set(pointer, parsedPath);
    return { ok: true, path: parsedPath.slice() };
  } catch (error) {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_POINTER",
      message: error instanceof Error ? error.message : "invalid pointer",
      path: pointer,
      opIndex,
    };
  }
}

function resolveNodeAtPath(
  root: Node,
  path: string[],
):
  | { ok: true; node: Node }
  | { ok: false; error: Omit<ApplyError, "ok" | "code"> & { code: 409 } } {
  let current = root;

  for (const segment of path) {
    if (current.kind === "obj") {
      const entry = current.entries.get(segment);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "MISSING_PARENT",
            message: `Missing key '${segment}'`,
          },
        };
      }

      current = entry.node;
      continue;
    }

    if (current.kind === "seq") {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(segment)) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "INVALID_POINTER",
            message: `Expected array index, got '${segment}'`,
          },
        };
      }

      const index = Number(segment);
      if (!Number.isSafeInteger(index)) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${segment}'`,
          },
        };
      }

      const elemId = rgaIdAtIndex(current, index);
      if (elemId === undefined) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${segment}'`,
          },
        };
      }

      current = current.elems.get(elemId)!.value;
      continue;
    }

    return {
      ok: false,
      error: {
        code: 409,
        reason: "INVALID_TARGET",
        message: `Cannot traverse into non-container at '${segment}'`,
      },
    };
  }

  return { ok: true, node: current };
}

function parseArrayIndexTokenForDoc(
  token: string,
  op: "add" | "remove" | "replace",
  path: string,
  opIndex: number,
): { ok: true; index: number } | ApplyError {
  if (token === "-") {
    if (op !== "add") {
      return {
        ok: false,
        code: 409,
        reason: "INVALID_POINTER",
        message: `'-' index is only valid for add at ${path}`,
        path,
        opIndex,
      };
    }

    return { ok: true, index: Number.POSITIVE_INFINITY };
  }

  if (!ARRAY_INDEX_TOKEN_PATTERN.test(token)) {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_POINTER",
      message: `expected array index at ${path}`,
      path,
      opIndex,
    };
  }

  const index = Number(token);
  if (!Number.isSafeInteger(index)) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `array index is too large at ${path}`,
      path,
      opIndex,
    };
  }

  return { ok: true, index };
}

function validateArrayIndexBounds(
  index: number,
  op: "add" | "remove" | "replace",
  arrLength: number,
  path: string,
  opIndex: number,
): { ok: true; index: number } | ApplyError {
  if (op === "add") {
    if (index === Number.POSITIVE_INFINITY) {
      return { ok: true, index };
    }

    if (index > arrLength) {
      return {
        ok: false,
        code: 409,
        reason: "OUT_OF_BOUNDS",
        message: `index out of bounds at ${path}; expected 0..${arrLength}`,
        path,
        opIndex,
      };
    }
  } else if (index >= arrLength) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `index out of bounds at ${path}; expected 0..${Math.max(arrLength - 1, 0)}`,
      path,
      opIndex,
    };
  }

  return { ok: true, index };
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
