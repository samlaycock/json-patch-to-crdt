import type {
  CrdtState,
  DeserializeFailure,
  DeserializeOptions,
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
  TryDeserializeDocResult,
  TryDeserializeStateResult,
  VersionVector,
} from "./types";

import {
  ResourceBudgetError,
  ResourceBudgetMeter,
  createBudgetMeter,
  toBudgetDeserializeFailure,
} from "./budget";
import {
  OperationCancelledError,
  throwIfAborted,
  toCancellationDeserializeFailure,
} from "./cancellation";
import { createClock } from "./clock";
import { TraversalDepthError, assertTraversalDepth } from "./depth";
import { dotToElemId } from "./dot";
import {
  observeVersionVectorDot,
  readCachedObservedVersionVector,
  writeCachedObservedVersionVector,
} from "./version-vector";

const HEAD_ELEM_ID = "HEAD";
const SERIALIZED_DOC_VERSION = 1 as const;
const SERIALIZED_STATE_VERSION = 1 as const;

function createSerializedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setSerializedRecordValue<T>(out: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(out, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

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
  return {
    version: SERIALIZED_DOC_VERSION,
    root: serializeNode(doc.root),
  };
}

/** Reconstruct a CRDT document from its serialized form. */
export function deserializeDoc(data: SerializedDoc, options: DeserializeOptions = {}): Doc {
  const budgetMeter = createBudgetMeter(options.resourceBudget);
  return deserializeDocInternal(data, budgetMeter, options.signal);
}

function deserializeDocInternal(
  data: SerializedDoc,
  budgetMeter?: ResourceBudgetMeter,
  signal?: DeserializeOptions["signal"],
): Doc {
  throwIfAborted(signal);
  const raw = readSerializedDocEnvelope(data);

  if (!("root" in raw)) {
    fail("INVALID_SERIALIZED_SHAPE", "/root", "serialized doc is missing root");
  }

  const observed = Object.create(null) as VersionVector;
  const doc = { root: deserializeNode(raw.root, "/root", 0, budgetMeter, observed, signal) };
  writeCachedObservedVersionVector(doc, observed);
  return doc;
}

/** Non-throwing `deserializeDoc` variant with typed validation details. */
export function tryDeserializeDoc(
  data: SerializedDoc,
  options: DeserializeOptions = {},
): TryDeserializeDocResult {
  try {
    return { ok: true, doc: deserializeDoc(data, options) };
  } catch (error) {
    const deserializeError = toDeserializeFailure(error);
    if (deserializeError) {
      return { ok: false, error: deserializeError };
    }

    throw error;
  }
}

/** Serialize a full CRDT state (document + clock) to a JSON-safe representation. */
export function serializeState(state: CrdtState): SerializedState {
  return {
    version: SERIALIZED_STATE_VERSION,
    doc: serializeDoc(state.doc),
    clock: { actor: state.clock.actor, ctr: state.clock.ctr },
  };
}

/**
 * Reconstruct a full CRDT state from its serialized form, restoring the clock.
 *
 * May throw `TraversalDepthError` when the payload exceeds the maximum
 * supported nesting depth.
 */
export function deserializeState(
  data: SerializedState,
  options: DeserializeOptions = {},
): CrdtState {
  try {
    const raw = readSerializedStateEnvelope(data);
    const budgetMeter = createBudgetMeter(options.resourceBudget);
    throwIfAborted(options.signal);

    if (!("doc" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", "/doc", "serialized state is missing doc");
    }

    if (!("clock" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", "/clock", "serialized state is missing clock");
    }

    const clockRaw = asRecord(raw.clock, "/clock");
    const actor = readActor(clockRaw.actor, "/clock/actor");
    const ctr = readCounter(clockRaw.ctr, "/clock/ctr");
    const doc = deserializeDocInternal(raw.doc as SerializedDoc, budgetMeter, options.signal);
    const observedCtr = readCachedObservedVersionVector(doc)?.[actor] ?? 0;
    const clock = createClock(actor, Math.max(ctr, observedCtr));
    return { doc, clock };
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      throw new DeserializeError("OPERATION_CANCELLED", "/", error.message);
    }

    throw error;
  }
}

/** Non-throwing `deserializeState` variant with typed validation details. */
export function tryDeserializeState(
  data: SerializedState,
  options: DeserializeOptions = {},
): TryDeserializeStateResult {
  try {
    return { ok: true, state: deserializeState(data, options) };
  } catch (error) {
    const deserializeError = toDeserializeFailure(error);
    if (deserializeError) {
      return { ok: false, error: deserializeError };
    }

    throw error;
  }
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
    const entries = createSerializedRecord<{ node: SerializedNode; dot: Dot }>();
    for (const [k, v] of node.entries.entries()) {
      setSerializedRecordValue(entries, k, {
        node: serializeNode(v.node),
        dot: { actor: v.dot.actor, ctr: v.dot.ctr },
      });
    }

    const tombstone = createSerializedRecord<Dot>();
    for (const [k, d] of node.tombstone.entries()) {
      setSerializedRecordValue(tombstone, k, { actor: d.actor, ctr: d.ctr });
    }

    return { kind: "obj", entries, tombstone };
  }

  const elems = createSerializedRecord<SerializedRgaElem>();
  for (const [id, e] of node.elems.entries()) {
    const serializedElem: SerializedRgaElem = {
      id: e.id,
      prev: e.prev,
      tombstone: e.tombstone,
      value: serializeNode(e.value),
      insDot: { actor: e.insDot.actor, ctr: e.insDot.ctr },
    };
    if (e.delDot) {
      serializedElem.delDot = { actor: e.delDot.actor, ctr: e.delDot.ctr };
    }

    setSerializedRecordValue(elems, id, serializedElem);
  }

  return { kind: "seq", elems };
}

function readSerializedDocEnvelope(data: SerializedDoc): Record<string, unknown> {
  const raw = asRecord(data, "/");
  assertSerializedEnvelopeVersion(raw, "/version", SERIALIZED_DOC_VERSION, "doc");
  return raw;
}

function readSerializedStateEnvelope(data: SerializedState): Record<string, unknown> {
  const raw = asRecord(data, "/");
  assertSerializedEnvelopeVersion(raw, "/version", SERIALIZED_STATE_VERSION, "state");
  return raw;
}

function deserializeNode(
  node: unknown,
  path: string,
  depth: number,
  budgetMeter?: ResourceBudgetMeter,
  observed?: VersionVector,
  signal?: DeserializeOptions["signal"],
): Node {
  throwIfAborted(signal);
  assertTraversalDepth(depth);
  budgetMeter?.count("visitedNodes", 1, path);
  const raw = asRecord(node, path);
  const kind = readString(raw.kind, `${path}/kind`);

  if (kind === "lww") {
    if (!("value" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", `${path}/value`, "lww node is missing value");
    }
    if (!("dot" in raw)) {
      fail("INVALID_SERIALIZED_SHAPE", `${path}/dot`, "lww node is missing dot");
    }

    const dot = readDot(raw.dot, `${path}/dot`);
    if (observed) {
      observeVersionVectorDot(observed, dot);
    }

    return {
      kind: "lww",
      value: structuredClone(
        readJsonValue(raw.value, `${path}/value`, depth + 1, budgetMeter, signal),
      ),
      dot,
    };
  }

  if (kind === "obj") {
    const entriesRaw = asRecord(raw.entries, `${path}/entries`);
    const tombstoneRaw = asRecord(raw.tombstone, `${path}/tombstone`);
    budgetMeter?.count("objectEntries", Object.keys(entriesRaw).length, `${path}/entries`);
    budgetMeter?.count("serializedElements", Object.keys(entriesRaw).length, `${path}/entries`);
    budgetMeter?.count("objectEntries", Object.keys(tombstoneRaw).length, `${path}/tombstone`);
    budgetMeter?.count("serializedElements", Object.keys(tombstoneRaw).length, `${path}/tombstone`);

    const entries = new Map<string, { node: Node; dot: Dot }>();
    for (const [k, v] of Object.entries(entriesRaw)) {
      throwIfAborted(signal);
      const entryPath = `${path}/entries/${k}`;
      const entryRaw = asRecord(v, entryPath);
      const dot = readDot(entryRaw.dot, `${entryPath}/dot`);
      if (observed) {
        observeVersionVectorDot(observed, dot);
      }
      entries.set(k, {
        node: deserializeNode(
          entryRaw.node,
          `${entryPath}/node`,
          depth + 1,
          budgetMeter,
          observed,
          signal,
        ),
        dot,
      });
    }

    const tombstone = new Map<string, Dot>();
    for (const [k, d] of Object.entries(tombstoneRaw)) {
      throwIfAborted(signal);
      const dot = readDot(d, `${path}/tombstone/${k}`);
      if (observed) {
        observeVersionVectorDot(observed, dot);
      }
      tombstone.set(k, dot);
    }

    return { kind: "obj", entries, tombstone };
  }

  if (kind !== "seq") {
    fail("INVALID_SERIALIZED_SHAPE", `${path}/kind`, `unsupported node kind '${kind}'`);
  }

  const elemsRaw = asRecord(raw.elems, `${path}/elems`);
  budgetMeter?.count("sequenceElements", Object.keys(elemsRaw).length, `${path}/elems`);
  budgetMeter?.count("serializedElements", Object.keys(elemsRaw).length, `${path}/elems`);
  const elems = new Map<string, RgaElem>();
  for (const [id, rawElem] of Object.entries(elemsRaw)) {
    throwIfAborted(signal);
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
    const value = deserializeNode(
      elem.value,
      `${elemPath}/value`,
      depth + 1,
      budgetMeter,
      observed,
      signal,
    );
    const insDot = readDot(elem.insDot, `${elemPath}/insDot`);
    const delDot =
      "delDot" in elem && elem.delDot !== undefined
        ? readDot(elem.delDot, `${elemPath}/delDot`)
        : undefined;
    if (observed) {
      observeVersionVectorDot(observed, insDot);
      if (delDot) {
        observeVersionVectorDot(observed, delDot);
      }
    }
    if (dotToElemId(insDot) !== id) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${elemPath}/insDot`,
        "sequence element id must match its insertion dot",
      );
    }
    if (!tombstone && delDot) {
      fail(
        "INVALID_SERIALIZED_INVARIANT",
        `${elemPath}/delDot`,
        "live sequence elements must not include delete metadata",
      );
    }

    elems.set(id, {
      id,
      prev,
      tombstone,
      delDot,
      value,
      insDot,
    });
  }

  for (const elem of elems.values()) {
    throwIfAborted(signal);
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

  assertAcyclicRgaPredecessors(elems, path);

  return { kind: "seq", elems };
}

function assertAcyclicRgaPredecessors(elems: Map<string, RgaElem>, path: string): void {
  const visitState = new Map<string, 1 | 2>();

  for (const startId of elems.keys()) {
    if (visitState.get(startId) === 2) {
      continue;
    }

    const trail: string[] = [];
    const trailSet = new Set<string>();
    let currentId: string | undefined = startId;

    while (currentId) {
      if (trailSet.has(currentId)) {
        fail(
          "INVALID_SERIALIZED_INVARIANT",
          `${path}/elems/${currentId}/prev`,
          `sequence predecessor cycle detected at '${currentId}'`,
        );
      }

      if (visitState.get(currentId) === 2) {
        break;
      }

      trail.push(currentId);
      trailSet.add(currentId);
      visitState.set(currentId, 1);

      const elem = elems.get(currentId);
      if (!elem || elem.prev === HEAD_ELEM_ID) {
        break;
      }

      currentId = elem.prev;
    }

    for (const id of trail) {
      visitState.set(id, 2);
    }
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected object");
  }

  return value;
}

function assertSerializedEnvelopeVersion(
  raw: Record<string, unknown>,
  path: string,
  expectedVersion: number,
  label: "doc" | "state",
): void {
  if (!("version" in raw)) {
    return;
  }

  const version = readVersion(raw.version, path);
  if (version !== expectedVersion) {
    fail("INVALID_SERIALIZED_SHAPE", path, `unsupported serialized ${label} version '${version}'`);
  }
}

function readVersion(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_SERIALIZED_SHAPE", path, "envelope version must be a non-negative safe integer");
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

function readJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budgetMeter?: ResourceBudgetMeter,
  signal?: DeserializeOptions["signal"],
): JsonValue {
  assertJsonValue(value, path, depth, budgetMeter, signal);
  return value;
}

function assertJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budgetMeter?: ResourceBudgetMeter,
  signal?: DeserializeOptions["signal"],
): asserts value is JsonValue {
  throwIfAborted(signal);
  assertTraversalDepth(depth);
  budgetMeter?.count("visitedNodes", 1, path);

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
    budgetMeter?.count("sequenceElements", value.length, path);
    budgetMeter?.count("serializedElements", value.length, path);
    for (const [index, item] of value.entries()) {
      throwIfAborted(signal);
      assertJsonValue(item, `${path}/${index}`, depth + 1, budgetMeter, signal);
    }

    return;
  }

  if (!isRecord(value)) {
    fail("INVALID_SERIALIZED_SHAPE", path, "expected JSON value");
  }

  const entries = Object.entries(value);
  budgetMeter?.count("objectEntries", entries.length, path);
  budgetMeter?.count("serializedElements", entries.length, path);
  for (const [key, child] of entries) {
    throwIfAborted(signal);
    assertJsonValue(child, `${path}/${key}`, depth + 1, budgetMeter, signal);
  }
}

function fail(reason: DeserializeErrorReason, path: string, message: string): never {
  throw new DeserializeError(reason, path, message);
}

function toDeserializeFailure(error: unknown): DeserializeFailure | null {
  if (error instanceof ResourceBudgetError) {
    return toBudgetDeserializeFailure(error);
  }

  if (error instanceof OperationCancelledError) {
    return toCancellationDeserializeFailure(error);
  }

  if (error instanceof DeserializeError || error instanceof TraversalDepthError) {
    return error;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
