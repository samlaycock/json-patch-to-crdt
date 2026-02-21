import type { Dot, ElemId, VersionVector } from "./types";

function readVvCounter(vv: VersionVector, actor: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(vv, actor)) {
    return undefined;
  }

  const counter = vv[actor];
  return typeof counter === "number" ? counter : undefined;
}

function writeVvCounter(vv: VersionVector, actor: string, counter: number): void {
  Object.defineProperty(vv, actor, {
    configurable: true,
    enumerable: true,
    value: counter,
    writable: true,
  });
}

// total order for LWW (tie-break actor lexicographically)
export function compareDot(a: Dot, b: Dot): number {
  if (a.ctr !== b.ctr) {
    return a.ctr - b.ctr;
  }

  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

export function vvHasDot(vv: VersionVector, d: Dot): boolean {
  return (readVvCounter(vv, d.actor) ?? 0) >= d.ctr;
}

export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out = Object.create(null) as VersionVector;

  for (const [actor, ctr] of Object.entries(a)) {
    writeVvCounter(out, actor, ctr);
  }

  for (const [actor, ctr] of Object.entries(b)) {
    writeVvCounter(out, actor, Math.max(readVvCounter(out, actor) ?? 0, ctr));
  }

  return out;
}

export function dotToElemId(d: Dot): ElemId {
  return `${d.actor}:${d.ctr}`;
}
