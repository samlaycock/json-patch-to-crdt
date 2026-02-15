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

function deepNodeFromJson(value: JsonValue, dot: Dot): Node {
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
      rgaInsertAfter(seq, prev, id, childDot, deepNodeFromJson(v, childDot));
      prev = id;
    }
    return seq;
  }
  const obj = newObj();
  for (const [k, v] of Object.entries(value)) {
    objSet(obj, k, deepNodeFromJson(v, dot), dot);
  }
  return obj;
}

function nodeFromJson(value: JsonValue, nextDot: () => Dot): Node {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return newReg(value, nextDot());
  }

  if (Array.isArray(value)) {
    const seq = newSeq();
    let prev = HEAD;
    for (const v of value) {
      const insDot = nextDot();
      const id = dotToElemId(insDot);
      rgaInsertAfter(seq, prev, id, insDot, nodeFromJson(v, nextDot));
      prev = id;
    }
    return seq;
  }

  const obj = newObj();
  for (const [k, v] of Object.entries(value)) {
    const entryDot = nextDot();
    objSet(obj, k, nodeFromJson(v, nextDot), entryDot);
  }
  return obj;
}

/** Deep-clone a CRDT document. The clone is fully independent of the original. */
export function cloneDoc(doc: Doc): Doc {
  return { root: cloneNode(doc.root) };
}

function cloneNode(node: Node): Node {
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
        node: cloneNode(v.node),
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
      value: cloneNode(e.value),
      insDot: { actor: e.insDot.actor, ctr: e.insDot.ctr },
    });
  }

  return { kind: "seq", elems };
}

// ── Per-intent handlers ─────────────────────────────────────────────

function applyTest(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "Test" }>,
  evalTestAgainst: "head" | "base",
): ApplyResult | null {
  const snapshot = evalTestAgainst === "head" ? materialize(head.root) : materialize(base.root);
  let got: JsonValue;

  try {
    got = getAtJson(snapshot, it.path);
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
): ApplyResult | null {
  const baseSeq = getSeqAtPath(base, it.path);

  if (!baseSeq) {
    if (it.index === 0 || it.index === Number.POSITIVE_INFINITY) {
      const headSeq = ensureSeqAtPath(head, it.path, newDot());
      const prev =
        it.index === 0 ? HEAD : rgaPrevForInsertAtIndex(headSeq, Number.MAX_SAFE_INTEGER);
      const d = nextInsertDotForPrev(headSeq, prev, newDot, bumpCounterAbove);
      const id = dotToElemId(d);
      rgaInsertAfter(headSeq, prev, id, d, nodeFromJson(it.value, newDot));
      return null;
    }

    return {
      ok: false,
      code: 409,
      reason: "MISSING_PARENT",
      message: `base array missing at /${it.path.join("/")}`,
      path: `/${it.path.join("/")}`,
    };
  }

  const headSeq = ensureSeqAtPath(head, it.path, newDot());
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
  const d = nextInsertDotForPrev(headSeq, prev, newDot, bumpCounterAbove);
  const id = dotToElemId(d);
  rgaInsertAfter(headSeq, prev, id, d, nodeFromJson(it.value, newDot));

  return null;
}

function nextInsertDotForPrev(
  seq: RgaSeq,
  prev: ElemId,
  newDot: () => Dot,
  bumpCounterAbove?: (ctr: number) => void,
): Dot {
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
    bumpCounterAbove?.(maxSiblingDot.ctr);
  }

  let candidate = newDot();
  while (maxSiblingDot && compareDot(candidate, maxSiblingDot) <= 0) {
    candidate = newDot();
  }

  return candidate;
}

function applyArrDelete(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrDelete" }>,
  newDot: () => Dot,
): ApplyResult | null {
  const d = newDot();
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

  const headSeq = ensureSeqAtPath(head, it.path, d);
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

  rgaDelete(headSeq, baseId);

  return null;
}

function applyArrReplace(
  base: Doc,
  head: Doc,
  it: Extract<IntentOp, { t: "ArrReplace" }>,
  newDot: () => Dot,
): ApplyResult | null {
  const d = newDot();
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

  const headSeq = ensureSeqAtPath(head, it.path, d);
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
 * @returns `{ ok: true }` on success, or `{ ok: false, code: 409, message }` on conflict.
 */
export function applyIntentsToCrdt(
  base: Doc,
  head: Doc,
  intents: IntentOp[],
  newDot: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
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
        fail = applyArrInsert(base, head, it, newDot, bumpCounterAbove);
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
 * - positional: `jsonPatchToCrdt(base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?)`
 * - object: `jsonPatchToCrdt({ base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?, semantics? })`
 */
export function jsonPatchToCrdt(options: JsonPatchToCrdtOptions): ApplyResult;
export function jsonPatchToCrdt(
  base: Doc,
  head: Doc,
  patch: JsonPatchOp[],
  newDot: () => Dot,
  evalTestAgainst?: "head" | "base",
  bumpCounterAbove?: (ctr: number) => void,
): ApplyResult;
export function jsonPatchToCrdt(
  baseOrOptions: Doc | JsonPatchToCrdtOptions,
  head?: Doc,
  patch?: JsonPatchOp[],
  newDot?: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
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
): ApplyResult;
export function jsonPatchToCrdtSafe(
  baseOrOptions: Doc | JsonPatchToCrdtOptions,
  head?: Doc,
  patch?: JsonPatchOp[],
  newDot?: () => Dot,
  evalTestAgainst: "head" | "base" = "head",
  bumpCounterAbove?: (ctr: number) => void,
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

    return jsonPatchToCrdt(baseOrOptions, head, patch, newDot, evalTestAgainst, bumpCounterAbove);
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
    );
  }

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
    );
    if (!headStep.ok) {
      return withOpIndex(headStep, opIndex);
    }

    if (evalTestAgainst === "base") {
      const shadowStep = applyIntentsToCrdt(
        shadowBase,
        shadowBase,
        intents,
        shadowDot,
        "base",
        shadowBump,
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
