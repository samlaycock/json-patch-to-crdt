import type { Dot, ElemId, Node, RgaElem, RgaSeq } from "./types";

import { compareDot } from "./dot";

export const HEAD: ElemId = "HEAD";

// Cache for linearized IDs, invalidated on mutation.
const linearCache = new WeakMap<RgaSeq, { version: number; ids: ElemId[] }>();
const seqVersion = new WeakMap<RgaSeq, number>();

function getVersion(seq: RgaSeq): number {
  return seqVersion.get(seq) ?? 0;
}

function bumpVersion(seq: RgaSeq): void {
  seqVersion.set(seq, getVersion(seq) + 1);
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

export function rgaLinearizeIds(seq: RgaSeq): ElemId[] {
  const ver = getVersion(seq);
  const cached = linearCache.get(seq);
  if (cached && cached.version === ver) {
    return cached.ids;
  }

  const idx = rgaChildrenIndex(seq);
  const out: ElemId[] = [];
  const stack: Array<{ children: RgaElem[]; index: number }> = [];
  const rootChildren = idx.get(HEAD);
  if (rootChildren) {
    stack.push({ children: rootChildren, index: 0 });
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.children.length) {
      stack.pop();
      continue;
    }

    const child = frame.children[frame.index++]!;
    if (!child.tombstone) {
      out.push(child.id);
    }

    const grandchildren = idx.get(child.id);
    if (grandchildren) {
      stack.push({ children: grandchildren, index: 0 });
    }
  }

  linearCache.set(seq, { version: ver, ids: out });
  return out;
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
  bumpVersion(seq);
}

export function rgaDelete(seq: RgaSeq, id: ElemId): void {
  const e = seq.elems.get(id);
  if (!e) {
    return; // delete unseen => can store tombstone separately if you want
  }

  if (e.tombstone) {
    return;
  }

  e.tombstone = true;
  bumpVersion(seq);
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
    if (!elem || !elem.tombstone || !isStable(elem.insDot)) {
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
  bumpVersion(seq);
  return removable.size;
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
