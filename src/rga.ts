import type { Dot, ElemId, Node, RgaElem, RgaSeq } from "./types";

import { compareDot } from "./dot";

export const HEAD: ElemId = "HEAD";

// Cache for linearized IDs, invalidated on mutation.
const linearCache = new WeakMap<RgaSeq, { version: number; ids: ElemId[] }>();
const seqVersion = new WeakMap<RgaSeq, number>();
const maxSiblingInsDotByPrevCache = new WeakMap<RgaSeq, Map<ElemId, Dot>>();

function getVersion(seq: RgaSeq): number {
  return seqVersion.get(seq) ?? 0;
}

function bumpVersion(seq: RgaSeq): void {
  seqVersion.set(seq, getVersion(seq) + 1);
}

function buildMaxSiblingInsDotByPrevIndex(seq: RgaSeq): Map<ElemId, Dot> {
  const index = new Map<ElemId, Dot>();

  for (const elem of seq.elems.values()) {
    const current = index.get(elem.prev);
    if (!current || compareDot(elem.insDot, current) > 0) {
      index.set(elem.prev, elem.insDot);
    }
  }

  maxSiblingInsDotByPrevCache.set(seq, index);
  return index;
}

function getMaxSiblingInsDotByPrevIndex(seq: RgaSeq): Map<ElemId, Dot> {
  return maxSiblingInsDotByPrevCache.get(seq) ?? buildMaxSiblingInsDotByPrevIndex(seq);
}

function trackInsertedSiblingDot(seq: RgaSeq, prev: ElemId, insDot: Dot): void {
  const index = maxSiblingInsDotByPrevCache.get(seq);
  if (!index) {
    return;
  }

  const current = index.get(prev);
  if (!current || compareDot(insDot, current) > 0) {
    index.set(prev, insDot);
  }
}

function rgaChildrenIndex(seq: RgaSeq): Map<ElemId, RgaElem[]> {
  const idx = new Map<ElemId, RgaElem[]>();

  for (const e of seq.elems.values()) {
    const arr = idx.get(e.prev) ?? [];
    arr.push(e);
    idx.set(e.prev, arr);
  }

  for (const arr of idx.values()) {
    // Latest insert at a given predecessor appears first. This matches
    // index-based JSON Patch expectations for repeated inserts at one position.
    arr.sort((a, b) => compareDot(b.insDot, a.insDot));
  }

  return idx;
}

type RgaLinearCursor = {
  next: () => RgaElem | undefined;
};

export type RgaIndexedIdSnapshot = {
  length: () => number;
  idAt: (index: number) => ElemId | undefined;
  prevForInsertAt: (index: number) => ElemId;
  insertAt: (index: number, id: ElemId) => void;
  deleteAt: (index: number) => ElemId | undefined;
};

export type RgaValidationIssue =
  | {
      code: "MISSING_PREDECESSOR";
      id: ElemId;
      prev: ElemId;
      message: string;
    }
  | {
      code: "PREDECESSOR_CYCLE";
      id: ElemId;
      prev: ElemId;
      message: string;
    }
  | {
      code: "ORPHANED_ELEMENT";
      id: ElemId;
      prev: ElemId;
      message: string;
    };

export type RgaValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: RgaValidationIssue[] };

export function rgaCreateLinearCursor(seq: RgaSeq): RgaLinearCursor {
  const idx = rgaChildrenIndex(seq);
  const stack: Array<{ children: RgaElem[]; index: number }> = [];
  const rootChildren = idx.get(HEAD);
  if (rootChildren) {
    stack.push({ children: rootChildren, index: 0 });
  }

  return {
    next() {
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.index >= frame.children.length) {
          stack.pop();
          continue;
        }

        const child = frame.children[frame.index++]!;
        const grandchildren = idx.get(child.id);
        if (grandchildren) {
          stack.push({ children: grandchildren, index: 0 });
        }

        if (!child.tombstone) {
          return child;
        }
      }

      return undefined;
    },
  };
}

export function rgaLinearizeIds(seq: RgaSeq): ElemId[] {
  const ver = getVersion(seq);
  const cached = linearCache.get(seq);
  if (cached && cached.version === ver) {
    return [...cached.ids];
  }

  const out: ElemId[] = [];
  const cursor = rgaCreateLinearCursor(seq);
  for (let child = cursor.next(); child; child = cursor.next()) {
    out.push(child.id);
  }

  linearCache.set(seq, { version: ver, ids: out });
  return [...out];
}

export function rgaCreateIndexedIdSnapshot(seq: RgaSeq): RgaIndexedIdSnapshot {
  const ids = rgaLinearizeIds(seq);

  return {
    length() {
      return ids.length;
    },
    idAt(index: number) {
      return ids[index];
    },
    prevForInsertAt(index: number) {
      if (index <= 0) {
        return HEAD;
      }

      const prev = ids[index - 1];
      return prev ?? (ids.length > 0 ? ids[ids.length - 1]! : HEAD);
    },
    insertAt(index: number, id: ElemId) {
      const at = Math.max(0, Math.min(index, ids.length));
      ids.splice(at, 0, id);
    },
    deleteAt(index: number) {
      if (index < 0 || index >= ids.length) {
        return undefined;
      }

      const [removed] = ids.splice(index, 1);
      return removed;
    },
  };
}

export function rgaInsertAfter(
  seq: RgaSeq,
  prev: ElemId,
  id: ElemId,
  insDot: Dot,
  value: Node,
): void {
  if (seq.elems.has(id)) {
    return; // idempotent
  }

  seq.elems.set(id, { id, prev, tombstone: false, value, insDot });
  trackInsertedSiblingDot(seq, prev, insDot);
  bumpVersion(seq);
}

export function rgaInsertAfterChecked(
  seq: RgaSeq,
  prev: ElemId,
  id: ElemId,
  insDot: Dot,
  value: Node,
): void {
  if (seq.elems.has(id)) {
    return; // preserve idempotent insert semantics
  }

  if (prev !== HEAD && !seq.elems.has(prev)) {
    throw new Error(`RGA predecessor '${prev}' does not exist`);
  }

  rgaInsertAfter(seq, prev, id, insDot, value);
}

export function rgaDelete(seq: RgaSeq, id: ElemId, delDot?: Dot): void {
  const e = seq.elems.get(id);
  if (!e) {
    return; // delete unseen => can store tombstone separately if you want
  }

  if (e.tombstone) {
    if (delDot && (!e.delDot || compareDot(delDot, e.delDot) > 0)) {
      e.delDot = { actor: delDot.actor, ctr: delDot.ctr };
      bumpVersion(seq);
    }
    return;
  }

  e.tombstone = true;
  if (delDot) {
    e.delDot = { actor: delDot.actor, ctr: delDot.ctr };
  }
  bumpVersion(seq);
}

export function validateRgaSeq(seq: RgaSeq): RgaValidationResult {
  const issues: RgaValidationIssue[] = [];

  for (const elem of seq.elems.values()) {
    if (elem.prev !== HEAD && !seq.elems.has(elem.prev)) {
      issues.push({
        code: "MISSING_PREDECESSOR",
        id: elem.id,
        prev: elem.prev,
        message: `RGA element '${elem.id}' references missing predecessor '${elem.prev}'`,
      });
    }
  }

  const cycleIds = new Set<ElemId>();
  const visitState = new Map<ElemId, 1 | 2>();
  const sortedIds = [...seq.elems.keys()].sort();

  for (const startId of sortedIds) {
    if (visitState.get(startId) === 2) {
      continue;
    }

    const trail: ElemId[] = [];
    const trailIndex = new Map<ElemId, number>();
    let currentId: ElemId | undefined = startId;

    while (currentId !== undefined) {
      const seenAt = trailIndex.get(currentId);
      if (seenAt !== undefined) {
        for (let i = seenAt; i < trail.length; i++) {
          cycleIds.add(trail[i]!);
        }
        break;
      }

      if (visitState.get(currentId) === 2) {
        break;
      }

      const elem = seq.elems.get(currentId);
      if (!elem) {
        break;
      }

      trailIndex.set(currentId, trail.length);
      trail.push(currentId);

      if (elem.prev === HEAD) {
        break;
      }

      currentId = elem.prev;
    }

    for (const id of trail) {
      visitState.set(id, 2);
    }
  }

  for (const id of [...cycleIds].sort()) {
    const elem = seq.elems.get(id)!;
    issues.push({
      code: "PREDECESSOR_CYCLE",
      id,
      prev: elem.prev,
      message: `RGA predecessor cycle detected at '${id}'`,
    });
  }

  const children = rgaChildrenIndex(seq);
  const reachable = new Set<ElemId>();
  const stack = [...(children.get(HEAD) ?? [])];

  while (stack.length > 0) {
    const elem = stack.pop()!;
    if (reachable.has(elem.id)) {
      continue;
    }

    reachable.add(elem.id);
    const descendants = children.get(elem.id);
    if (descendants) {
      stack.push(...descendants);
    }
  }

  for (const id of sortedIds) {
    if (reachable.has(id)) {
      continue;
    }

    const elem = seq.elems.get(id)!;
    issues.push({
      code: "ORPHANED_ELEMENT",
      id,
      prev: elem.prev,
      message: `RGA element '${id}' is unreachable from HEAD`,
    });
  }

  if (issues.length === 0) {
    return { ok: true, issues: [] };
  }

  const issueOrder: Record<RgaValidationIssue["code"], number> = {
    MISSING_PREDECESSOR: 0,
    PREDECESSOR_CYCLE: 1,
    ORPHANED_ELEMENT: 2,
  };
  issues.sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      issueOrder[a.code] - issueOrder[b.code] ||
      a.prev.localeCompare(b.prev),
  );
  return { ok: false, issues };
}

/**
 * Prune tombstoned elements that are causally stable and have no live descendants
 * depending on them for sequence traversal.
 *
 * Returns the number of removed elements.
 */
export function rgaCompactTombstones(seq: RgaSeq, isStable: (dot: Dot) => boolean): number {
  if (seq.elems.size === 0) {
    return 0;
  }

  const children = new Map<ElemId, ElemId[]>();
  const roots: ElemId[] = [];

  for (const elem of seq.elems.values()) {
    const byPrev = children.get(elem.prev);
    if (byPrev) {
      byPrev.push(elem.id);
    } else {
      children.set(elem.prev, [elem.id]);
    }

    if (elem.prev === HEAD || !seq.elems.has(elem.prev)) {
      roots.push(elem.id);
    }
  }

  const removable = new Set<ElemId>();
  const visited = new Set<ElemId>();
  const stack: Array<{ id: ElemId; expanded: boolean }> = [];
  const pushRoot = (id: ElemId) => {
    if (!visited.has(id)) {
      stack.push({ id, expanded: false });
    }
  };

  for (const id of roots) {
    pushRoot(id);
  }
  for (const id of seq.elems.keys()) {
    pushRoot(id);
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (!frame.expanded) {
      if (visited.has(frame.id)) {
        continue;
      }

      visited.add(frame.id);
      stack.push({ id: frame.id, expanded: true });
      const childIds = children.get(frame.id);
      if (childIds) {
        for (const childId of childIds) {
          if (!visited.has(childId)) {
            stack.push({ id: childId, expanded: false });
          }
        }
      }
      continue;
    }

    const elem = seq.elems.get(frame.id);
    if (!elem || !elem.tombstone || !elem.delDot || !isStable(elem.delDot)) {
      continue;
    }

    const childIds = children.get(frame.id);
    const allChildrenRemovable = !childIds || childIds.every((childId) => removable.has(childId));
    if (allChildrenRemovable) {
      removable.add(frame.id);
    }
  }

  if (removable.size === 0) {
    return 0;
  }

  for (const id of removable) {
    seq.elems.delete(id);
  }
  maxSiblingInsDotByPrevCache.delete(seq);
  bumpVersion(seq);
  return removable.size;
}

export function rgaMaxInsertDotForPrev(seq: RgaSeq, prev: ElemId): Dot | null {
  return getMaxSiblingInsDotByPrevIndex(seq).get(prev) ?? null;
}

export function rgaIdAtIndex(seq: RgaSeq, index: number): ElemId | undefined {
  const ids = rgaLinearizeIds(seq);
  return ids[index];
}

export function rgaPrevForInsertAtIndex(seq: RgaSeq, index: number): ElemId {
  // Insert at index i means "after element at i-1", or HEAD for i=0.
  if (index <= 0) {
    return HEAD;
  }

  const ids = rgaLinearizeIds(seq);
  const prev = ids[index - 1];

  return prev ?? (ids.length ? ids[ids.length - 1]! : HEAD);
}
