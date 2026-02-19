import type {
  ApplyError,
  ActorId,
  CrdtState,
  Doc,
  Dot,
  LwwReg,
  MergeDocOptions,
  MergeStateOptions,
  Node,
  ObjNode,
  PatchErrorReason,
  RgaElem,
  RgaSeq,
  TryMergeDocResult,
  TryMergeStateResult,
} from "./types";

import { createClock } from "./clock";
import { TraversalDepthError, assertTraversalDepth, toDepthApplyError } from "./depth";
import { compareDot } from "./dot";

/** Error thrown by throwing merge helpers (`mergeDoc` / `mergeState`). */
export class MergeError extends Error {
  readonly code: 409;
  readonly reason: PatchErrorReason;
  readonly path?: string;

  constructor(error: ApplyError) {
    super(error.message);
    this.name = "MergeError";
    this.code = error.code;
    this.reason = error.reason;
    this.path = error.path;
  }
}

/**
 * Merge two CRDT documents from different peers into one.
 * By default this requires shared array lineage for non-empty sequences.
 *
 * Resolution rules:
 * - **LwwReg**: the register with the higher dot wins (total order by counter then actor).
 * - **ObjNode**: entries are merged key-by-key; tombstones use max-dot-per-key.
 *   If both sides have a live entry for the same key, the entry nodes are merged recursively.
 *   Delete-wins: if a tombstone dot >= an entry dot, the entry is removed.
 * - **RgaSeq**: elements from both sides are unioned by element ID.
 *   If both sides have the same element, tombstone wins (delete bias) and values are merged recursively.
 * - **Kind mismatch**: the node with the higher "representative dot" wins and replaces the other entirely.
 */
export function mergeDoc(a: Doc, b: Doc, options: MergeDocOptions = {}): Doc {
  const result = tryMergeDoc(a, b, options);
  if (!result.ok) {
    throw new MergeError(result.error);
  }

  return result.doc;
}

/** Non-throwing `mergeDoc` variant with structured conflict details. */
export function tryMergeDoc(a: Doc, b: Doc, options: MergeDocOptions = {}): TryMergeDocResult {
  try {
    const requireSharedOrigin = options.requireSharedOrigin ?? true;
    const mismatchPath = requireSharedOrigin ? findSeqLineageMismatch(a.root, b.root, []) : null;
    if (mismatchPath) {
      return {
        ok: false,
        error: {
          ok: false,
          code: 409,
          reason: "LINEAGE_MISMATCH",
          message: `merge requires shared array origin at ${mismatchPath}`,
          path: mismatchPath,
        },
      };
    }

    return { ok: true, doc: { root: mergeNode(a.root, b.root) } };
  } catch (error) {
    if (error instanceof TraversalDepthError) {
      return { ok: false, error: toDepthApplyError(error) };
    }

    throw error;
  }
}

/**
 * Merge two CRDT states.
 *
 * The merged clock keeps a stable actor identity:
 * - defaults to the actor from the first argument (`a`)
 * - can be overridden via `options.actor`
 * - optional `options.requireSharedOrigin` controls merge lineage checks
 *
 * The merged counter is lifted to the highest counter already observed for
 * that actor across both input clocks and the merged document dots.
 */
export function mergeState(a: CrdtState, b: CrdtState, options: MergeStateOptions = {}): CrdtState {
  const result = tryMergeState(a, b, options);
  if (!result.ok) {
    throw new MergeError(result.error);
  }

  return result.state;
}

/** Non-throwing `mergeState` variant with structured conflict details. */
export function tryMergeState(
  a: CrdtState,
  b: CrdtState,
  options: MergeStateOptions = {},
): TryMergeStateResult {
  const mergedDoc = tryMergeDoc(a.doc, b.doc, {
    requireSharedOrigin: options.requireSharedOrigin,
  });
  if (!mergedDoc.ok) {
    return mergedDoc;
  }

  const doc = mergedDoc.doc;
  const actor = options.actor ?? a.clock.actor;
  const ctr = maxObservedCtrForActor(doc, actor, a, b);
  return { ok: true, state: { doc, clock: createClock(actor, ctr) } };
}

function findSeqLineageMismatch(a: Node, b: Node, path: string[]): string | null {
  const stack: Array<{ a: Node; b: Node; path: string[]; depth: number }> = [
    { a, b, path, depth: path.length },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.a.kind === "seq" && frame.b.kind === "seq") {
      const hasElemsA = frame.a.elems.size > 0;
      const hasElemsB = frame.b.elems.size > 0;
      if (hasElemsA && hasElemsB) {
        let shared = false;
        for (const id of frame.a.elems.keys()) {
          if (frame.b.elems.has(id)) {
            shared = true;
            break;
          }
        }

        if (!shared) {
          return `/${frame.path.join("/")}`;
        }
      }
    }

    if (frame.a.kind === "obj" && frame.b.kind === "obj") {
      const left = frame.a;
      const right = frame.b;
      const sharedKeys = [...left.entries.keys()].filter((key) => right.entries.has(key));
      for (let i = sharedKeys.length - 1; i >= 0; i--) {
        const key = sharedKeys[i]!;
        const nextA = left.entries.get(key)!.node;
        const nextB = right.entries.get(key)!.node;
        stack.push({
          a: nextA,
          b: nextB,
          path: [...frame.path, key],
          depth: frame.depth + 1,
        });
      }
    }
  }

  return null;
}

function maxObservedCtrForActor(doc: Doc, actor: ActorId, a: CrdtState, b: CrdtState): number {
  let best = maxCtrInNodeForActor(doc.root, actor);

  if (a.clock.actor === actor && a.clock.ctr > best) {
    best = a.clock.ctr;
  }

  if (b.clock.actor === actor && b.clock.ctr > best) {
    best = b.clock.ctr;
  }

  return best;
}

function maxCtrInNodeForActor(node: Node, actor: ActorId): number {
  let best = 0;
  const stack: Array<{ node: Node; depth: number }> = [{ node, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.node.kind === "lww") {
      if (frame.node.dot.actor === actor && frame.node.dot.ctr > best) {
        best = frame.node.dot.ctr;
      }
      continue;
    }

    if (frame.node.kind === "obj") {
      for (const entry of frame.node.entries.values()) {
        if (entry.dot.actor === actor && entry.dot.ctr > best) {
          best = entry.dot.ctr;
        }
        stack.push({ node: entry.node, depth: frame.depth + 1 });
      }

      for (const tomb of frame.node.tombstone.values()) {
        if (tomb.actor === actor && tomb.ctr > best) {
          best = tomb.ctr;
        }
      }
      continue;
    }

    for (const elem of frame.node.elems.values()) {
      if (elem.insDot.actor === actor && elem.insDot.ctr > best) {
        best = elem.insDot.ctr;
      }
      stack.push({ node: elem.value, depth: frame.depth + 1 });
    }
  }

  return best;
}

function repDot(node: Node): Dot {
  switch (node.kind) {
    case "lww":
      return node.dot;
    case "obj": {
      // Use the max dot across all entries and tombstones.
      let best: Dot = { actor: "", ctr: 0 };
      for (const entry of node.entries.values()) {
        if (compareDot(entry.dot, best) > 0) best = entry.dot;
      }
      for (const d of node.tombstone.values()) {
        if (compareDot(d, best) > 0) best = d;
      }
      return best;
    }
    case "seq": {
      let best: Dot = { actor: "", ctr: 0 };
      for (const e of node.elems.values()) {
        if (compareDot(e.insDot, best) > 0) best = e.insDot;
      }
      return best;
    }
  }
}

function mergeNode(a: Node, b: Node): Node {
  return mergeNodeAtDepth(a, b, 0);
}

function mergeNodeAtDepth(a: Node, b: Node, depth: number): Node {
  assertTraversalDepth(depth);

  // Same kind → merge semantics
  if (a.kind === "lww" && b.kind === "lww") return mergeLww(a, b);
  if (a.kind === "obj" && b.kind === "obj") return mergeObj(a, b, depth + 1);
  if (a.kind === "seq" && b.kind === "seq") return mergeSeq(a, b, depth + 1);

  // Kind mismatch: higher representative dot wins entirely.
  const cmp = compareDot(repDot(a), repDot(b));
  if (cmp >= 0) return cloneNodeShallow(a, depth + 1);
  return cloneNodeShallow(b, depth + 1);
}

function mergeLww(a: LwwReg, b: LwwReg): LwwReg {
  if (compareDot(a.dot, b.dot) >= 0) {
    return { kind: "lww", value: structuredClone(a.value), dot: { ...a.dot } };
  }
  return { kind: "lww", value: structuredClone(b.value), dot: { ...b.dot } };
}

function mergeObj(a: ObjNode, b: ObjNode, depth: number): ObjNode {
  assertTraversalDepth(depth);
  const entries = new Map<string, { node: Node; dot: Dot }>();
  const tombstone = new Map<string, Dot>();

  // Merge tombstones: max dot per key.
  const allTombKeys = new Set([...a.tombstone.keys(), ...b.tombstone.keys()]);
  for (const key of allTombKeys) {
    const da = a.tombstone.get(key);
    const db = b.tombstone.get(key);
    if (da && db) {
      tombstone.set(key, compareDot(da, db) >= 0 ? { ...da } : { ...db });
    } else if (da) {
      tombstone.set(key, { ...da });
    } else {
      tombstone.set(key, { ...db! });
    }
  }

  // Merge entries: union of keys, recursive merge when both present.
  const allKeys = new Set([...a.entries.keys(), ...b.entries.keys()]);
  for (const key of allKeys) {
    const ea = a.entries.get(key);
    const eb = b.entries.get(key);

    let merged: { node: Node; dot: Dot };
    if (ea && eb) {
      const mergedNode = mergeNodeAtDepth(ea.node, eb.node, depth + 1);
      const dot = compareDot(ea.dot, eb.dot) >= 0 ? { ...ea.dot } : { ...eb.dot };
      merged = { node: mergedNode, dot };
    } else if (ea) {
      merged = { node: cloneNodeShallow(ea.node, depth + 1), dot: { ...ea.dot } };
    } else {
      merged = { node: cloneNodeShallow(eb!.node, depth + 1), dot: { ...eb!.dot } };
    }

    // Delete-wins check: if tombstone dot >= entry dot, drop the entry.
    const td = tombstone.get(key);
    if (td && compareDot(td, merged.dot) >= 0) {
      continue; // deleted
    }

    entries.set(key, merged);
  }

  return { kind: "obj", entries, tombstone };
}

function mergeSeq(a: RgaSeq, b: RgaSeq, depth: number): RgaSeq {
  assertTraversalDepth(depth);
  const elems = new Map<string, RgaElem>();

  // Union by element ID.
  const allIds = new Set([...a.elems.keys(), ...b.elems.keys()]);
  for (const id of allIds) {
    const ea = a.elems.get(id);
    const eb = b.elems.get(id);

    if (ea && eb) {
      // Both sides have this element. Merge:
      // - tombstone: true if either side tombstoned it
      // - value: recursively merge child nodes
      // - prev/insDot should be identical (same element), use either
      const mergedValue = mergeNodeAtDepth(ea.value, eb.value, depth + 1);
      elems.set(id, {
        id,
        prev: ea.prev,
        tombstone: ea.tombstone || eb.tombstone,
        value: mergedValue,
        insDot: { ...ea.insDot },
      });
    } else if (ea) {
      elems.set(id, cloneElem(ea, depth + 1));
    } else {
      elems.set(id, cloneElem(eb!, depth + 1));
    }
  }

  return { kind: "seq", elems };
}

function cloneElem(e: RgaElem, depth: number): RgaElem {
  assertTraversalDepth(depth);
  return {
    id: e.id,
    prev: e.prev,
    tombstone: e.tombstone,
    value: cloneNodeShallow(e.value, depth + 1),
    insDot: { ...e.insDot },
  };
}

function cloneNodeShallow(node: Node, depth: number): Node {
  assertTraversalDepth(depth);
  switch (node.kind) {
    case "lww":
      return { kind: "lww", value: structuredClone(node.value), dot: { ...node.dot } };
    case "obj": {
      const entries = new Map<string, { node: Node; dot: Dot }>();
      for (const [k, v] of node.entries) {
        entries.set(k, { node: cloneNodeShallow(v.node, depth + 1), dot: { ...v.dot } });
      }
      const tombstone = new Map<string, Dot>();
      for (const [k, d] of node.tombstone) {
        tombstone.set(k, { ...d });
      }
      return { kind: "obj", entries, tombstone };
    }
    case "seq": {
      const elems = new Map<string, RgaElem>();
      for (const [id, e] of node.elems) {
        elems.set(id, cloneElem(e, depth + 1));
      }
      return { kind: "seq", elems };
    }
  }
}
