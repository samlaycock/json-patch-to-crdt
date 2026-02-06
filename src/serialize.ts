import type {
  CrdtState,
  Doc,
  Dot,
  RgaElem,
  SerializedDoc,
  SerializedNode,
  SerializedRgaElem,
  SerializedState,
} from "./types";
import { createClock } from "./clock";

/** Serialize a CRDT document to a JSON-safe representation (Maps become plain objects). */
export function serializeDoc(doc: Doc): SerializedDoc {
  return { root: serializeNode(doc.root) };
}

/** Reconstruct a CRDT document from its serialized form. */
export function deserializeDoc(data: SerializedDoc): Doc {
  return { root: deserializeNode(data.root) };
}

/** Serialize a full CRDT state (document + clock) to a JSON-safe representation. */
export function serializeState(state: CrdtState): SerializedState {
  return {
    doc: serializeDoc(state.doc),
    clock: { actor: state.clock.actor, ctr: state.clock.ctr },
  };
}

/** Reconstruct a full CRDT state from its serialized form, restoring the clock. */
export function deserializeState(data: SerializedState): CrdtState {
  const clock = createClock(data.clock.actor, data.clock.ctr);
  const doc = deserializeDoc(data.doc);
  return { doc, clock };
}

function serializeNode(node: Doc["root"]): SerializedNode {
  if (node.kind === "lww") {
    return {
      kind: "lww",
      value: structuredClone(node.value),
      dot: { actor: node.dot.actor, ctr: node.dot.ctr },
    };
  }

  if (node.kind === "obj") {
    const entries: Record<string, { node: SerializedNode; dot: Dot }> = {};
    for (const [k, v] of node.entries.entries()) {
      entries[k] = {
        node: serializeNode(v.node),
        dot: { actor: v.dot.actor, ctr: v.dot.ctr },
      };
    }

    const tombstone: Record<string, Dot> = {};
    for (const [k, d] of node.tombstone.entries()) {
      tombstone[k] = { actor: d.actor, ctr: d.ctr };
    }

    return { kind: "obj", entries, tombstone };
  }

  const elems: Record<string, SerializedRgaElem> = {};
  for (const [id, e] of node.elems.entries()) {
    elems[id] = {
      id: e.id,
      prev: e.prev,
      tombstone: e.tombstone,
      value: serializeNode(e.value),
      insDot: { actor: e.insDot.actor, ctr: e.insDot.ctr },
    };
  }

  return { kind: "seq", elems };
}

function deserializeNode(node: SerializedNode): Doc["root"] {
  if (node.kind === "lww") {
    return {
      kind: "lww",
      value: structuredClone(node.value),
      dot: { actor: node.dot.actor, ctr: node.dot.ctr },
    };
  }

  if (node.kind === "obj") {
    const entries = new Map<string, { node: Doc["root"]; dot: Dot }>();
    for (const [k, v] of Object.entries(node.entries)) {
      entries.set(k, {
        node: deserializeNode(v.node),
        dot: { actor: v.dot.actor, ctr: v.dot.ctr },
      });
    }

    const tombstone = new Map<string, Dot>();
    for (const [k, d] of Object.entries(node.tombstone)) {
      tombstone.set(k, { actor: d.actor, ctr: d.ctr });
    }

    return { kind: "obj", entries, tombstone };
  }

  const elems = new Map<string, RgaElem>();
  for (const [id, e] of Object.entries(node.elems)) {
    elems.set(id, {
      id: e.id,
      prev: e.prev,
      tombstone: e.tombstone,
      value: deserializeNode(e.value),
      insDot: { actor: e.insDot.actor, ctr: e.insDot.ctr },
    });
  }

  return { kind: "seq", elems };
}
