import type {
  CompactDocTombstonesResult,
  CompactStateTombstonesResult,
  CrdtState,
  Doc,
  Dot,
  Node,
  TombstoneCompactionOptions,
  VersionVector,
} from "./types";

import { cloneClock } from "./clock";
import { assertTraversalDepth } from "./depth";
import { cloneDoc } from "./doc";
import { objCompactTombstones } from "./nodes";
import { rgaCompactTombstones } from "./rga";

function isDotStable(stable: VersionVector, dot: Dot): boolean {
  return (stable[dot.actor] ?? 0) >= dot.ctr;
}

/**
 * Compact causally-stable tombstones in a document.
 *
 * Safety note:
 * - Only compact at checkpoints that are causally stable across all peers you
 *   may still merge with.
 * - Do not merge this compacted document with replicas that might be behind
 *   the provided checkpoint.
 */
export function compactDocTombstones(
  doc: Doc,
  options: TombstoneCompactionOptions,
): CompactDocTombstonesResult {
  const targetDoc = options.mutate ? doc : cloneDoc(doc);
  const stats = {
    objectTombstonesRemoved: 0,
    sequenceTombstonesRemoved: 0,
  };
  const stable = options.stable;
  const stack: Array<{ node: Node; depth: number }> = [{ node: targetDoc.root, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.node.kind === "obj") {
      stats.objectTombstonesRemoved += objCompactTombstones(frame.node, (dot) =>
        isDotStable(stable, dot),
      );

      for (const entry of frame.node.entries.values()) {
        stack.push({ node: entry.node, depth: frame.depth + 1 });
      }
      continue;
    }

    if (frame.node.kind === "seq") {
      stats.sequenceTombstonesRemoved += rgaCompactTombstones(frame.node, (dot) =>
        isDotStable(stable, dot),
      );

      for (const elem of frame.node.elems.values()) {
        stack.push({ node: elem.value, depth: frame.depth + 1 });
      }
    }
  }

  return {
    doc: targetDoc,
    stats,
  };
}

/**
 * Compact causally-stable tombstones in a state document.
 *
 * Safety note:
 * - Only compact at checkpoints that are causally stable across all peers you
 *   may still merge with.
 * - Do not merge this compacted state with replicas that might be behind the
 *   provided checkpoint.
 */
export function compactStateTombstones(
  state: CrdtState,
  options: TombstoneCompactionOptions,
): CompactStateTombstonesResult {
  if (options.mutate) {
    const docResult = compactDocTombstones(state.doc, {
      stable: options.stable,
      mutate: true,
    });
    return {
      state,
      stats: docResult.stats,
    };
  }

  const nextState = {
    doc: cloneDoc(state.doc),
    clock: cloneClock(state.clock),
  };
  const docResult = compactDocTombstones(nextState.doc, {
    stable: options.stable,
    mutate: true,
  });

  return {
    state: nextState,
    stats: docResult.stats,
  };
}
