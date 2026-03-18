import type { Dot, ElemId, VersionVector } from "./types";

import { mergeVersionVectors, readVersionVectorCounter } from "./version-vector";

// total order for LWW (tie-break actor lexicographically)
export function compareDot(a: Dot, b: Dot): number {
  if (a.ctr !== b.ctr) {
    return a.ctr - b.ctr;
  }

  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

export function vvHasDot(vv: VersionVector, d: Dot): boolean {
  return (readVersionVectorCounter(vv, d.actor) ?? 0) >= d.ctr;
}

export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  return mergeVersionVectors(a, b);
}

export function dotToElemId(d: Dot): ElemId {
  return `${d.actor}:${d.ctr}`;
}
