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
  ResourceBudgetKind,
  TryMergeDocResult,
  TryMergeStateResult,
  UnrelatedArraysStrategy,
} from "./types";

import { ResourceBudgetError, createBudgetMeter, toBudgetApplyError } from "./budget";
import { createClock } from "./clock";
import { TraversalDepthError, assertTraversalDepth, toDepthApplyError } from "./depth";
import { compareDot } from "./dot";
import { stringifyJsonPointer } from "./patch";

class SharedElementMetadataMismatchError extends Error {
  readonly path: string;

  constructor(path: string, id: string, field: "prev" | "insDot") {
    super(`shared RGA element '${id}' has conflicting ${field} metadata`);
    this.name = "SharedElementMetadataMismatchError";
    this.path = path;
  }
}

type MergeNodeResult = {
  node: Node;
  maxObservedCtr: number;
};

type MergeDocResult = {
  doc: Doc;
  maxObservedCtr: number;
};

type MergeConfig = {
  actor?: ActorId;
  unrelatedArrays: UnrelatedArraysStrategy;
  budgetMeter?: ReturnType<typeof createBudgetMeter>;
};

/** Error thrown by throwing merge helpers (`mergeDoc` / `mergeState`). */
export class MergeError extends Error {
  readonly code: 409;
  readonly reason: PatchErrorReason;
  readonly budget?: ResourceBudgetKind;
  readonly limit?: number;
  readonly actual?: number;
  readonly path?: string;

  constructor(error: ApplyError) {
    super(error.message);
    this.name = "MergeError";
    this.code = error.code;
    this.reason = error.reason;
    if (error.reason === "RESOURCE_BUDGET_EXCEEDED") {
      this.budget = error.budget;
      this.limit = error.limit;
      this.actual = error.actual;
    }
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
    const config: MergeConfig = {
      unrelatedArrays: resolveUnrelatedArraysStrategy(options),
      budgetMeter: createBudgetMeter(options.resourceBudget),
    };

    if (config.unrelatedArrays === "reject") {
      const mismatchPath = findSeqLineageMismatch(a.root, b.root, [], config);
      if (mismatchPath !== null) {
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
    }

    return { ok: true, doc: mergeDocRoot(a.root, b.root, config).doc };
  } catch (error) {
    if (error instanceof SharedElementMetadataMismatchError) {
      return {
        ok: false,
        error: {
          ok: false,
          code: 409,
          reason: "LINEAGE_MISMATCH",
          message: error.message,
          path: error.path,
        },
      };
    }

    if (error instanceof TraversalDepthError) {
      return { ok: false, error: toDepthApplyError(error) };
    }

    if (error instanceof ResourceBudgetError) {
      return { ok: false, error: toBudgetApplyError(error) };
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
 * - optional `options.unrelatedArrays` controls the merge strategy for non-overlapping sequences
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
  try {
    const actor = options.actor ?? a.clock.actor;
    const config: MergeConfig = {
      actor,
      unrelatedArrays: resolveUnrelatedArraysStrategy(options),
      budgetMeter: createBudgetMeter(options.resourceBudget),
    };

    if (config.unrelatedArrays === "reject") {
      const mismatchPath = findSeqLineageMismatch(a.doc.root, b.doc.root, [], config);
      if (mismatchPath !== null) {
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
    }

    const merged = mergeDocRoot(a.doc.root, b.doc.root, config);
    const ctr = maxObservedCtrForActor(merged.maxObservedCtr, actor, a, b);
    return { ok: true, state: { doc: merged.doc, clock: createClock(actor, ctr) } };
  } catch (error) {
    if (error instanceof SharedElementMetadataMismatchError) {
      return {
        ok: false,
        error: {
          ok: false,
          code: 409,
          reason: "LINEAGE_MISMATCH",
          message: error.message,
          path: error.path,
        },
      };
    }

    if (error instanceof TraversalDepthError) {
      return { ok: false, error: toDepthApplyError(error) };
    }

    if (error instanceof ResourceBudgetError) {
      return { ok: false, error: toBudgetApplyError(error) };
    }

    throw error;
  }
}

function findSeqLineageMismatch(
  a: Node,
  b: Node,
  path: string[],
  config: MergeConfig,
): string | null {
  const pathBuffer = [...path];
  const stack: Array<{ a: Node; b: Node; key?: string; depth: number }> = [
    { a, b, depth: path.length },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);
    pathBuffer.length = frame.depth;
    if (frame.key !== undefined) {
      pathBuffer[frame.depth - 1] = frame.key;
    }

    const budgetPath = config.budgetMeter ? stringifyJsonPointer(pathBuffer) : undefined;
    config.budgetMeter?.count("visitedNodes", 1, budgetPath);

    if (frame.a.kind === "seq" && frame.b.kind === "seq") {
      config.budgetMeter?.count(
        "sequenceElements",
        frame.a.elems.size + frame.b.elems.size,
        budgetPath,
      );
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
          return stringifyJsonPointer(pathBuffer);
        }
      }
    }

    if (frame.a.kind === "obj" && frame.b.kind === "obj") {
      const left = frame.a;
      const right = frame.b;
      let sharedKeyCount = 0;

      for (const key of left.entries.keys()) {
        if (right.entries.has(key)) {
          sharedKeyCount += 1;
        }
      }

      config.budgetMeter?.count("objectEntries", sharedKeyCount, budgetPath);
      for (const key of left.entries.keys()) {
        if (!right.entries.has(key)) {
          continue;
        }

        const nextA = left.entries.get(key)!.node;
        const nextB = right.entries.get(key)!.node;
        stack.push({
          a: nextA,
          b: nextB,
          depth: frame.depth + 1,
          key,
        });
      }
    }
  }

  return null;
}

function mergeDocRoot(a: Node, b: Node, config: MergeConfig): MergeDocResult {
  const merged = mergeNodeAtDepth(a, b, 0, [], config);
  return { doc: { root: merged.node }, maxObservedCtr: merged.maxObservedCtr };
}

function resolveUnrelatedArraysStrategy(
  options: MergeDocOptions | MergeStateOptions,
): UnrelatedArraysStrategy {
  if (options.unrelatedArrays !== undefined) return options.unrelatedArrays;
  if (options.requireSharedOrigin === false) return "unsafe-union";
  return "reject";
}

function maxObservedCtrForActor(
  docObservedCtr: number,
  actor: ActorId,
  a: CrdtState,
  b: CrdtState,
): number {
  let best = docObservedCtr;

  if (a.clock.actor === actor && a.clock.ctr > best) {
    best = a.clock.ctr;
  }

  if (b.clock.actor === actor && b.clock.ctr > best) {
    best = b.clock.ctr;
  }

  return best;
}

function repDot(node: Node): Dot {
  let best: Dot = { actor: "", ctr: 0 };
  const stack: Array<{ node: Node; depth: number }> = [{ node, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    switch (frame.node.kind) {
      case "lww":
        if (compareDot(frame.node.dot, best) > 0) {
          best = frame.node.dot;
        }
        break;
      case "obj":
        for (const entry of frame.node.entries.values()) {
          if (compareDot(entry.dot, best) > 0) {
            best = entry.dot;
          }

          stack.push({ node: entry.node, depth: frame.depth + 1 });
        }
        for (const tombstone of frame.node.tombstone.values()) {
          if (compareDot(tombstone, best) > 0) {
            best = tombstone;
          }
        }
        break;
      case "seq":
        for (const elem of frame.node.elems.values()) {
          if (compareDot(elem.insDot, best) > 0) {
            best = elem.insDot;
          }

          if (elem.delDot && compareDot(elem.delDot, best) > 0) {
            best = elem.delDot;
          }

          stack.push({ node: elem.value, depth: frame.depth + 1 });
        }
        break;
    }
  }

  return best;
}

function mergeNodeAtDepth(
  a: Node,
  b: Node,
  depth: number,
  path: string[],
  config: MergeConfig,
): MergeNodeResult {
  assertTraversalDepth(depth);
  config.budgetMeter?.count("visitedNodes", 1, stringifyJsonPointer(path));

  // Same kind → merge semantics
  if (a.kind === "lww" && b.kind === "lww") return mergeLww(a, b, config.actor);
  if (a.kind === "obj" && b.kind === "obj") return mergeObj(a, b, depth + 1, path, config);
  if (a.kind === "seq" && b.kind === "seq") return mergeSeq(a, b, depth + 1, path, config);

  // Kind mismatch: higher representative dot wins entirely.
  const cmp = compareDot(repDot(a), repDot(b));
  if (cmp >= 0) return cloneNodeShallow(a, depth + 1, config.actor);
  return cloneNodeShallow(b, depth + 1, config.actor);
}

function mergeLww(a: LwwReg, b: LwwReg, actor?: ActorId): MergeNodeResult {
  if (compareDot(a.dot, b.dot) >= 0) {
    return {
      node: { kind: "lww", value: structuredClone(a.value), dot: { ...a.dot } },
      maxObservedCtr: maxObservedCtrForDot(a.dot, actor),
    };
  }
  return {
    node: { kind: "lww", value: structuredClone(b.value), dot: { ...b.dot } },
    maxObservedCtr: maxObservedCtrForDot(b.dot, actor),
  };
}

function mergeObj(
  a: ObjNode,
  b: ObjNode,
  depth: number,
  path: string[],
  config: MergeConfig,
): MergeNodeResult {
  assertTraversalDepth(depth);
  const entries = new Map<string, { node: Node; dot: Dot }>();
  const tombstone = new Map<string, Dot>();
  let maxObservedCtr = 0;

  // Merge tombstones: max dot per key.
  const allTombKeys = new Set([...a.tombstone.keys(), ...b.tombstone.keys()]);
  config.budgetMeter?.count("objectEntries", allTombKeys.size, stringifyJsonPointer(path));
  for (const key of allTombKeys) {
    const da = a.tombstone.get(key);
    const db = b.tombstone.get(key);
    if (da && db) {
      const mergedDot = compareDot(da, db) >= 0 ? { ...da } : { ...db };
      tombstone.set(key, mergedDot);
      maxObservedCtr = Math.max(maxObservedCtr, maxObservedCtrForDot(mergedDot, config.actor));
    } else if (da) {
      tombstone.set(key, { ...da });
      maxObservedCtr = Math.max(maxObservedCtr, maxObservedCtrForDot(da, config.actor));
    } else {
      tombstone.set(key, { ...db! });
      maxObservedCtr = Math.max(maxObservedCtr, maxObservedCtrForDot(db!, config.actor));
    }
  }

  // Merge entries: union of keys, recursive merge when both present.
  const allKeys = new Set([...a.entries.keys(), ...b.entries.keys()]);
  config.budgetMeter?.count("objectEntries", allKeys.size, stringifyJsonPointer(path));
  for (const key of allKeys) {
    const ea = a.entries.get(key);
    const eb = b.entries.get(key);

    let merged: { node: Node; dot: Dot };
    let mergedNodeMaxObservedCtr = 0;
    if (ea && eb) {
      path.push(key);
      const mergedNode = (() => {
        try {
          return mergeNodeAtDepth(ea.node, eb.node, depth + 1, path, config);
        } finally {
          path.pop();
        }
      })();
      const dot = compareDot(ea.dot, eb.dot) >= 0 ? { ...ea.dot } : { ...eb.dot };
      merged = { node: mergedNode.node, dot };
      mergedNodeMaxObservedCtr = mergedNode.maxObservedCtr;
    } else if (ea) {
      const cloned = cloneNodeShallow(ea.node, depth + 1, config.actor);
      merged = { node: cloned.node, dot: { ...ea.dot } };
      mergedNodeMaxObservedCtr = cloned.maxObservedCtr;
    } else {
      const cloned = cloneNodeShallow(eb!.node, depth + 1, config.actor);
      merged = { node: cloned.node, dot: { ...eb!.dot } };
      mergedNodeMaxObservedCtr = cloned.maxObservedCtr;
    }

    // Delete-wins check: if tombstone dot >= entry dot, drop the entry.
    const td = tombstone.get(key);
    if (td && compareDot(td, merged.dot) >= 0) {
      continue; // deleted
    }

    entries.set(key, merged);
    maxObservedCtr = Math.max(
      maxObservedCtr,
      mergedNodeMaxObservedCtr,
      maxObservedCtrForDot(merged.dot, config.actor),
    );
  }

  return { node: { kind: "obj", entries, tombstone }, maxObservedCtr };
}

function mergeSeq(
  a: RgaSeq,
  b: RgaSeq,
  depth: number,
  path: string[],
  config: MergeConfig,
): MergeNodeResult {
  assertTraversalDepth(depth);
  config.budgetMeter?.count("visitedNodes", 1, stringifyJsonPointer(path));

  // Atomic-replace: when both seqs are non-empty and share no element IDs,
  // the one with the higher representative dot wins entirely.
  if (config.unrelatedArrays === "atomic-replace" && a.elems.size > 0 && b.elems.size > 0) {
    let shared = false;
    for (const id of a.elems.keys()) {
      if (b.elems.has(id)) {
        shared = true;
        break;
      }
    }
    if (!shared) {
      config.budgetMeter?.count(
        "sequenceElements",
        a.elems.size + b.elems.size,
        stringifyJsonPointer(path),
      );
      const winner = compareDot(repDot(a), repDot(b)) >= 0 ? a : b;
      return cloneNodeShallow(winner, depth, config.actor);
    }
  }

  const elems = new Map<string, RgaElem>();
  let maxObservedCtr = 0;

  // Union by element ID.
  const allIds = new Set([...a.elems.keys(), ...b.elems.keys()]);
  config.budgetMeter?.count("sequenceElements", allIds.size, stringifyJsonPointer(path));
  for (const id of allIds) {
    const ea = a.elems.get(id);
    const eb = b.elems.get(id);

    if (ea && eb) {
      if (ea.prev !== eb.prev) {
        throw new SharedElementMetadataMismatchError(stringifyJsonPointer(path), id, "prev");
      }

      if (!sameDot(ea.insDot, eb.insDot)) {
        throw new SharedElementMetadataMismatchError(stringifyJsonPointer(path), id, "insDot");
      }

      // Both sides have this element. Merge:
      // - tombstone: true if either side tombstoned it
      // - value: recursively merge child nodes
      // - prev/insDot are validated to match before merge
      path.push(id);
      const mergedValue = (() => {
        try {
          return mergeNodeAtDepth(ea.value, eb.value, depth + 1, path, config);
        } finally {
          path.pop();
        }
      })();
      const mergedDeleteDot = mergeDeleteDot(ea.delDot, eb.delDot);
      elems.set(id, {
        id,
        prev: ea.prev,
        tombstone: ea.tombstone || eb.tombstone,
        delDot: mergedDeleteDot,
        value: mergedValue.node,
        insDot: { ...ea.insDot },
      });
      maxObservedCtr = Math.max(
        maxObservedCtr,
        mergedValue.maxObservedCtr,
        maxObservedCtrForDot(ea.insDot, config.actor),
        maxObservedCtrForDot(mergedDeleteDot, config.actor),
      );
    } else if (ea) {
      const cloned = cloneElem(ea, depth + 1, config.actor);
      elems.set(id, cloned.elem);
      maxObservedCtr = Math.max(maxObservedCtr, cloned.maxObservedCtr);
    } else {
      const cloned = cloneElem(eb!, depth + 1, config.actor);
      elems.set(id, cloned.elem);
      maxObservedCtr = Math.max(maxObservedCtr, cloned.maxObservedCtr);
    }
  }

  return { node: { kind: "seq", elems }, maxObservedCtr };
}

function sameDot(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.ctr === b.ctr;
}

function cloneElem(
  e: RgaElem,
  depth: number,
  actor?: ActorId,
): { elem: RgaElem; maxObservedCtr: number } {
  assertTraversalDepth(depth);
  const value = cloneNodeShallow(e.value, depth + 1, actor);
  return {
    elem: {
      id: e.id,
      prev: e.prev,
      tombstone: e.tombstone,
      delDot: e.delDot ? { ...e.delDot } : undefined,
      value: value.node,
      insDot: { ...e.insDot },
    },
    maxObservedCtr: Math.max(
      value.maxObservedCtr,
      maxObservedCtrForDot(e.insDot, actor),
      maxObservedCtrForDot(e.delDot, actor),
    ),
  };
}

function mergeDeleteDot(a?: Dot, b?: Dot): Dot | undefined {
  if (a && b) {
    return compareDot(a, b) >= 0 ? { ...a } : { ...b };
  }

  if (a) {
    return { ...a };
  }

  if (b) {
    return { ...b };
  }

  return undefined;
}

function cloneNodeShallow(node: Node, depth: number, actor?: ActorId): MergeNodeResult {
  assertTraversalDepth(depth);
  switch (node.kind) {
    case "lww":
      return {
        node: { kind: "lww", value: structuredClone(node.value), dot: { ...node.dot } },
        maxObservedCtr: maxObservedCtrForDot(node.dot, actor),
      };
    case "obj": {
      const entries = new Map<string, { node: Node; dot: Dot }>();
      let maxObservedCtr = 0;
      for (const [k, v] of node.entries) {
        const cloned = cloneNodeShallow(v.node, depth + 1, actor);
        entries.set(k, { node: cloned.node, dot: { ...v.dot } });
        maxObservedCtr = Math.max(
          maxObservedCtr,
          cloned.maxObservedCtr,
          maxObservedCtrForDot(v.dot, actor),
        );
      }
      const tombstone = new Map<string, Dot>();
      for (const [k, d] of node.tombstone) {
        tombstone.set(k, { ...d });
        maxObservedCtr = Math.max(maxObservedCtr, maxObservedCtrForDot(d, actor));
      }
      return { node: { kind: "obj", entries, tombstone }, maxObservedCtr };
    }
    case "seq": {
      const elems = new Map<string, RgaElem>();
      let maxObservedCtr = 0;
      for (const [id, e] of node.elems) {
        const cloned = cloneElem(e, depth + 1, actor);
        elems.set(id, cloned.elem);
        maxObservedCtr = Math.max(maxObservedCtr, cloned.maxObservedCtr);
      }
      return { node: { kind: "seq", elems }, maxObservedCtr };
    }
  }
}

function maxObservedCtrForDot(dot: Dot | undefined, actor: ActorId | undefined): number {
  if (!dot || !actor || dot.actor !== actor) {
    return 0;
  }

  return dot.ctr;
}
