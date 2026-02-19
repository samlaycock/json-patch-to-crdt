import type {
  CrdtState,
  Doc,
  DeserializeErrorReason,
  Dot,
  JsonValue,
  Node,
  RgaElem,
  SerializedDoc,
  SerializedNode,
  SerializedRgaElem,
  SerializedState,
} from "./types";

import { createClock } from "./clock";
import { assertTraversalDepth } from "./depth";
import { dotToElemId } from "./dot";

const HEAD_ELEM_ID = "HEAD";

export class DeserializeError extends Error {
  readonly code = 409 as const;
  readonly reason: DeserializeErrorReason;
  readonly path: string;

  constructor(reason: DeserializeErrorReason, path: string, message: string) {
    super(message);
    this.name = "DeserializeError";
    this.reason = reason;
    this.path = path;
  }
}

/** Serialize a CRDT document to a JSON-safe representation (Maps become plain objects). */
export function serializeDoc(doc: Doc): SerializedDoc {
  return { root: serializeNode(doc.root) };
}

/** Reconstruct a CRDT document from its serialized form. */
export function deserializeDoc(data: SerializedDoc): Doc {
  if (!isRecord(data)) {
    fail("INVALID_SERIALIZED_SHAPE", "/", "serialized doc must be an object");
  }

  if (!("root" in data)) {
    fail("INVALID_SERIALIZED_SHAPE", "/root", "serialized doc is missing root");
  }

  return { root: deserializeNode(data.root, "/root", 0) };
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
  if (!isRecord(data)) {
    fail("INVALID_SERIALIZED_SHAPE", "/", "serialized state must be an object");
  }

  if (!("doc" in data)) {
    fail("INVALID_SERIALIZED_SHAPE", "/doc", "serialized state is missing doc");
  }

  if (!("clock" in data)) {
    fail("INVALID_SERIALIZED_SHAPE", "/clock", "serialized state is missing clock");
  }

  const clockRaw = asRecord(data.clock, "/clock");
  const actor = readActor(clockRaw.actor, "/clock/actor");
  const ctr = readCounter(clockRaw.ctr, "/clock/ctr");
  const clock = createClock(actor, ctr);
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

function deserializeNode(node: unknown, path: string, depth: number): Node {
  assertTraversalDepth(depth);
  const raw = asRecord(node, path);
  const kind = readString(raw.kind, `${path}/kind`);

  if (kind === "lww") {
    if (!("value" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", `${path}/value`, "lww node is missing value");
    }
    if (!("dot" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", `${path}/dot`, "lww node is missing dot");
    }

    return {
      kind: "lww",
      value: structuredClone(readJsonValue(raw.value, `${path}/value`, depth + 1)),
      dot: readDot(raw.dot, `${path}/dot`),
    };
  }

  if (kind === "obj") {
    const entriesRaw = asRecord(raw.entries, `${path}/entries`);
    const tombstoneRaw = asRecord(raw.tombstone, `${path}/tombstone`);

    const entries = new Map<string, { node: Node; dot: Dot }>();
    for (const [k, v] of Object.entries(entriesRaw)) {
      const entryPath = `${path}/entries/${k}`;
      const entryRaw = asRecord(v, entryPath);
      entries.set(k, {
        node: deserializeNode(entryRaw.node, `${entryPath}/node`, depth + 1),
        dot: readDot(entryRaw.dot, `${entryPath}/dot`),
      });
    }

    const tombstone = new Map<string, Dot>();
    for (const [k, d] of Object.entries(tombstoneRaw)) {
      tombstone.set(k, readDot(d, `${path}/tombstone/${k}`));
    }

    return { kind: "obj", entries, tombstone };
  }

  if (kind !== "seq") {
    fail("INVALID_SERIALIZED_SHAPE", `${path}/kind`, `unsupported node kind '${kind}'`);
  }

  const elemsRaw = asRecord(raw.elems, `${path}/elems`);
  const elems = new Map<string, RgaElem>();
  for (const [id, rawElem] of Object.entries(elemsRaw)) {
    const elemPath = `${path}/elems/${id}`;
    const elem = asRecord(rawElem, elemPath);
    const elemId = readString(elem.id, `${elemPath}/id`);
    if (elemId !== id) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${elemPath}/id`,
        `sequence element id '${elemId}' does not match key '${id}'`,
      );
    }

    const prev = readString(elem.prev, `${elemPath}/prev`);
    const tombstone = readBoolean(elem.tombstone, `${elemPath}/tombstone`);
    const value = deserializeNode(elem.value, `${elemPath}/value`, depth + 1);
    const insDot = readDot(elem.insDot, `${elemPath}/insDot`);
    if (dotToElemId(insDot) !== id) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${elemPath}/insDot`,
        "sequence element id must match its insertion dot",
      );
    }

    elems.set(id, {
      id,
      prev,
      tombstone,
      value,
      insDot,
    });
  }

  for (const elem of elems.values()) {
    if (elem.prev === elem.id) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${path}/elems/${elem.id}/prev`,
        "sequence element cannot reference itself as predecessor",
      );
    }

    if (elem.prev !== HEAD_ELEM_ID && !elems.has(elem.prev)) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${path}/elems/${elem.id}/prev`,
        `sequence predecessor '${elem.prev}' does not exist`,
      );
    }
  }

  return { kind: "seq", elems };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected object");
  }

  return value;
}

function readDot(value: unknown, path: string): Dot {
  const raw = asRecord(value, path);
  const actor = readActor(raw.actor, `${path}/actor`);
  const ctr = readCounter(raw.ctr, `${path}/ctr`);
  return { actor, ctr };
}

function readActor(value: unknown, path: string): string {
  const actor = readString(value, path);
  if (actor.length === 0) {
    fail("INVALID_SERIALIZED_SHAPE", path, "actor must not be empty");
  }

  return actor;
}

function readCounter(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_SERIALIZED_SHAPE", path, "counter must be a non-negative safe integer");
  }

  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected string");
  }

  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected boolean");
  }

  return value;
}

function readJsonValue(value: unknown, path: string, depth: number): JsonValue {
  assertJsonValue(value, path, depth);
  return value;
}

function assertJsonValue(value: unknown, path: string, depth: number): asserts value is JsonValue {
  assertTraversalDepth(depth);

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("INVALID_SERIALIZED_SHAPE", path, "json number must be finite");
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${path}/${index}`, depth + 1);
    }

    return;
  }

  if (!isRecord(value)) {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected JSON value");
  }

  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, `${path}/${key}`, depth + 1);
  }
}

function fail(reason: DeserializeErrorReason, path: string, message: string): never {
  throw new DeserializeError(reason, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
