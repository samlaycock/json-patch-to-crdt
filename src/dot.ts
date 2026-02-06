import type { Dot, ElemId, VersionVector } from "./types";

// total order for LWW (tie-break actor lexicographically)
export function compareDot(a: Dot, b: Dot): number {
  if (a.ctr !== b.ctr) {
    return a.ctr - b.ctr;
  }

  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

export function vvHasDot(vv: VersionVector, d: Dot): boolean {
  return (vv[d.actor] ?? 0) >= d.ctr;
}

export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };

  for (const [actor, ctr] of Object.entries(b)) {
    out[actor] = Math.max(out[actor] ?? 0, ctr);
  }

  return out;
}

export function dotToElemId(d: Dot): ElemId {
  return `${d.actor}:${d.ctr}`;
}
