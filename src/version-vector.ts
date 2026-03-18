import type { CrdtState, Doc, Dot, Node, VersionVector } from "./types";

import { assertTraversalDepth } from "./depth";

export function readVersionVectorCounter(vv: VersionVector, actor: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(vv, actor)) {
    return undefined;
  }

  const counter = vv[actor];
  return typeof counter === "number" ? counter : undefined;
}

export function writeVersionVectorCounter(vv: VersionVector, actor: string, counter: number): void {
  Object.defineProperty(vv, actor, {
    configurable: true,
    enumerable: true,
    value: counter,
    writable: true,
  });
}

export function observeVersionVectorDot(vv: VersionVector, dot: Dot): void {
  if ((readVersionVectorCounter(vv, dot.actor) ?? 0) < dot.ctr) {
    writeVersionVectorCounter(vv, dot.actor, dot.ctr);
  }
}

/** Inspect a document or state and return the highest observed counter per actor. */
export function observedVersionVector(target: Doc | CrdtState): VersionVector {
  const doc = "doc" in target ? target.doc : target;
  const vv = Object.create(null) as VersionVector;
  const stack: Array<{ node: Node; depth: number }> = [{ node: doc.root, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.node.kind === "lww") {
      observeVersionVectorDot(vv, frame.node.dot);
      continue;
    }

    if (frame.node.kind === "obj") {
      for (const entry of frame.node.entries.values()) {
        observeVersionVectorDot(vv, entry.dot);
        stack.push({ node: entry.node, depth: frame.depth + 1 });
      }

      for (const tombstone of frame.node.tombstone.values()) {
        observeVersionVectorDot(vv, tombstone);
      }
      continue;
    }

    for (const elem of frame.node.elems.values()) {
      observeVersionVectorDot(vv, elem.insDot);
      if (elem.delDot) {
        observeVersionVectorDot(vv, elem.delDot);
      }
      stack.push({ node: elem.value, depth: frame.depth + 1 });
    }
  }

  return vv;
}

/** Combine version vectors using per-actor maxima. */
export function mergeVersionVectors(...vectors: readonly VersionVector[]): VersionVector {
  const merged = Object.create(null) as VersionVector;

  for (const vv of vectors) {
    for (const actor of Object.keys(vv)) {
      const counter = readVersionVectorCounter(vv, actor);
      if (counter === undefined) {
        continue;
      }

      writeVersionVectorCounter(
        merged,
        actor,
        Math.max(readVersionVectorCounter(merged, actor) ?? 0, counter),
      );
    }
  }

  return merged;
}

/** Derive a causally-stable checkpoint by taking the per-actor minimum. */
export function intersectVersionVectors(...vectors: readonly VersionVector[]): VersionVector {
  if (vectors.length === 0) {
    return Object.create(null) as VersionVector;
  }

  const actors = new Set<string>();
  for (const vv of vectors) {
    for (const actor of Object.keys(vv)) {
      actors.add(actor);
    }
  }

  const intersection = Object.create(null) as VersionVector;
  for (const actor of actors) {
    const counters = vectors.map((vv) => readVersionVectorCounter(vv, actor) ?? 0);
    const counter = Math.min(...counters);
    if (counter > 0) {
      writeVersionVectorCounter(intersection, actor, counter);
    }
  }

  return intersection;
}

/** Check whether one version vector has observed every counter in another. */
export function versionVectorCovers(observed: VersionVector, required: VersionVector): boolean {
  for (const actor of Object.keys(required)) {
    const requiredCounter = readVersionVectorCounter(required, actor) ?? 0;
    if ((readVersionVectorCounter(observed, actor) ?? 0) < requiredCounter) {
      return false;
    }
  }

  return true;
}
