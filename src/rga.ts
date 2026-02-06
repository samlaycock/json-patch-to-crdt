import { compareDot } from "./dot";
import type { Dot, ElemId, Node, RgaElem, RgaSeq } from "./types";

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

  function walk(prev: ElemId) {
    const children = idx.get(prev);

    if (!children) {
      return;
    }

    for (const c of children) {
      if (!c.tombstone) {
        out.push(c.id);
      }

      walk(c.id);
    }
  }

  walk(HEAD);

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
