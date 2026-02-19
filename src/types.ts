/** Unique identifier for a CRDT replica (peer). */
export type ActorId = string;

/** A Lamport-style causality marker: `(actor, counter)`. */
export type Dot = {
  actor: ActorId;
  /** Strictly increasing per actor. */
  ctr: number;
};

/** Maps each known actor to the highest counter seen from that actor. */
export type VersionVector = Record<ActorId, number>;

// ---

/** A JSON leaf value: `null`, `boolean`, `number`, or `string`. */
export type JsonPrimitive = null | boolean | number | string;

/** Any JSON-compatible value (primitives, arrays, and plain objects). */
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

// ---

/** Mutable clock that tracks an actor's identity and monotonic counter. */
export type Clock = {
  actor: ActorId;
  ctr: number;
  /** Generate the next unique dot and advance the counter. */
  next: () => Dot;
};

/** Last-Writer-Wins register: stores a single JSON value tagged with a dot. */
export type LwwReg = {
  kind: "lww";
  value: JsonValue;
  dot: Dot;
};

// ---

/** Serialized element ID in the form `"actor:counter"`. */
export type ElemId = string;

/** A single element in an RGA sequence, with tombstone support. */
export type RgaElem = {
  id: ElemId;
  /** Predecessor element ID (`"HEAD"` for the first element). */
  prev: ElemId;
  /** Whether this element has been logically deleted. */
  tombstone: boolean;
  /** The child CRDT node stored at this position. */
  value: Node;
  /** Dot used for deterministic ordering among concurrent inserts with the same predecessor. */
  insDot: Dot;
};

/** Replicated Growable Array: an ordered sequence CRDT with tombstones. */
export type RgaSeq = {
  kind: "seq";
  elems: Map<ElemId, RgaElem>;
};

// ---

/** A single entry in an object node: a child node tagged with a dot. */
export type ObjEntry = { node: Node; dot: Dot };

/** Delete-wins object CRDT: a map of string keys to child nodes. */
export type ObjNode = {
  kind: "obj";
  entries: Map<string, ObjEntry>;
  /** Latest delete dot per key (delete-wins semantics). */
  tombstone: Map<string, Dot>;
};

// ---

/** A CRDT node: either an object, an RGA sequence, or a LWW register. */
export type Node = ObjNode | RgaSeq | LwwReg;

// ---

/** JSON-serializable form of an RGA element. */
export type SerializedRgaElem = {
  id: ElemId;
  prev: ElemId;
  tombstone: boolean;
  value: SerializedNode;
  insDot: Dot;
};

/** JSON-serializable form of any CRDT node. */
export type SerializedNode =
  | { kind: "lww"; value: JsonValue; dot: Dot }
  | {
      kind: "obj";
      entries: Record<string, { node: SerializedNode; dot: Dot }>;
      tombstone: Record<string, Dot>;
    }
  | { kind: "seq"; elems: Record<string, SerializedRgaElem> };

/** JSON-serializable form of a CRDT document. */
export type SerializedDoc = { root: SerializedNode };

/** JSON-serializable form of a clock. */
export type SerializedClock = { actor: ActorId; ctr: number };

/** JSON-serializable form of a full CRDT state (document + clock). */
export type SerializedState = { doc: SerializedDoc; clock: SerializedClock };

// ---

/**
 * Internal intent operations produced by compiling RFC 6902 JSON Patch ops.
 * Each variant maps to a specific CRDT mutation.
 */
export type IntentOp =
  | { t: "ObjSet"; path: string[]; key: string; value: JsonValue; mode?: "add" | "replace" }
  | { t: "ObjRemove"; path: string[]; key: string }
  | { t: "ArrInsert"; path: string[]; index: number; value: JsonValue }
  | { t: "ArrDelete"; path: string[]; index: number }
  | { t: "ArrReplace"; path: string[]; index: number; value: JsonValue }
  | { t: "Test"; path: string[]; value: JsonValue };

// ---

/** A single RFC 6902 JSON Patch operation. */
export type JsonPatchOp =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: JsonValue }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: JsonValue };

/** An array of JSON Patch operations (RFC 6902). */
export type JsonPatch = JsonPatchOp[];

// ---

/** Top-level CRDT document wrapper holding the root node. */
export type Doc = { root: Node };

/** Combined CRDT state: a document and its associated clock. */
export type CrdtState = { doc: Doc; clock: Clock };

/** Options for `forkState`. */
export interface ForkStateOptions {
  /**
   * Allow reusing the origin actor ID when forking.
   * Defaults to `false` to prevent duplicate-dot collisions across replicas.
   */
  allowActorReuse?: boolean;
}

/** Result from applying a patch for a specific actor using a shared version vector. */
export type ApplyPatchAsActorResult = {
  /** Updated CRDT state for the actor that produced this patch. */
  state: CrdtState;
  /** Updated version vector after applying the patch. */
  vv: VersionVector;
};

/** Options for internals-only `applyPatchAsActor`. */
export type ApplyPatchAsActorOptions = {
  base?: Doc;
  testAgainst?: "head" | "base";
  semantics?: PatchSemantics;
};

/** Typed failure reason used across patch/merge helpers. */
export type PatchErrorReason =
  | "INVALID_PATCH"
  | "INVALID_POINTER"
  | "MISSING_PARENT"
  | "MISSING_TARGET"
  | "INVALID_TARGET"
  | "OUT_OF_BOUNDS"
  | "TEST_FAILED"
  | "INVALID_MOVE"
  | "DOT_GENERATION_EXHAUSTED"
  | "MAX_DEPTH_EXCEEDED"
  | "LINEAGE_MISMATCH";

/** Structured conflict payload used by non-throwing APIs. */
export type ApplyError = {
  ok: false;
  /** HTTP-friendly status code for conflict-style failures. */
  code: 409;
  /** Machine-readable reason for branching logic. */
  reason: PatchErrorReason;
  /** Human-readable description of the failure. */
  message: string;
  /** Optional pointer/path context when available. */
  path?: string;
  /** Optional patch operation index when available. */
  opIndex?: number;
};

/** Result of applying a patch: success or structured conflict details. */
export type ApplyResult = { ok: true } | ApplyError;

/** How JSON Patch operations are interpreted during application. */
export type PatchSemantics = "base" | "sequential";

/** Options for compile/validation helpers. */
export type CompilePatchOptions = {
  semantics?: PatchSemantics;
};

/**
 * Options for immutable patch application (`applyPatch` / `tryApplyPatch`).
 * - `semantics: "sequential"` applies operations one-by-one against the evolving head (default).
 * - `semantics: "base"` maps array indices against a fixed snapshot.
 * - `base` should be a previously observed state snapshot from the same document lineage.
 */
export type ApplyPatchOptions = {
  base?: CrdtState;
  testAgainst?: "head" | "base";
  semantics?: PatchSemantics;
};

/** Options for in-place patch application (`applyPatchInPlace` / `tryApplyPatchInPlace`). */
export type ApplyPatchInPlaceOptions = ApplyPatchOptions & {
  atomic?: boolean;
};

/** Non-throwing result for immutable patch application. */
export type TryApplyPatchResult = { ok: true; state: CrdtState } | { ok: false; error: ApplyError };

/** Non-throwing result for in-place patch application. */
export type TryApplyPatchInPlaceResult = { ok: true } | { ok: false; error: ApplyError };

/** Non-throwing result for patch validation preflight. */
export type ValidatePatchResult = { ok: true } | { ok: false; error: ApplyError };

/** Options for `mergeState`. */
export type MergeStateOptions = {
  /**
   * Actor to use for the merged clock.
   * Defaults to the actor from the first state argument.
   */
  actor?: ActorId;
  /**
   * Require array sequences to share element lineage before merging.
   * Defaults to `true`.
   */
  requireSharedOrigin?: boolean;
};

/** Options for `mergeDoc`. */
export type MergeDocOptions = {
  /**
   * Require array sequences to share element lineage before merging.
   * Defaults to `true`.
   */
  requireSharedOrigin?: boolean;
};

/** Non-throwing result for `mergeDoc`. */
export type TryMergeDocResult = { ok: true; doc: Doc } | { ok: false; error: ApplyError };

/** Non-throwing result for `mergeState`. */
export type TryMergeStateResult = { ok: true; state: CrdtState } | { ok: false; error: ApplyError };

/** Options-object overload shape for low-level JSON Patch -> CRDT conversion. */
export type JsonPatchToCrdtOptions = {
  base: Doc;
  head: Doc;
  patch: JsonPatchOp[];
  newDot: () => Dot;
  evalTestAgainst?: "head" | "base";
  bumpCounterAbove?: (ctr: number) => void;
  semantics?: PatchSemantics;
};

/** Options for `crdtToJsonPatch` and `diffJsonPatch`. */
export type DiffOptions = { arrayStrategy?: "atomic" | "lcs" };

/**
 * Internal sentinel key used in `IntentOp` to represent root-level operations.
 * Namespaced to avoid collision with user data keys.
 */
export const ROOT_KEY = "@@crdt/root";
