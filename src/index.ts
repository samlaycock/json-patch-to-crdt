// Public API — the recommended surface for most consumers.

// Types
export type {
  ActorId,
  ApplyPatchAsActorResult,
  ApplyPatchOptions,
  ApplyResult,
  Clock,
  CrdtState,
  DiffOptions,
  Doc,
  Dot,
  ElemId,
  IntentOp,
  JsonPatch,
  JsonPatchOp,
  JsonPrimitive,
  JsonValue,
  LwwReg,
  MergeDocOptions,
  MergeStateOptions,
  Node,
  ObjEntry,
  ObjNode,
  PatchSemantics,
  RgaElem,
  RgaSeq,
  SerializedDoc,
  SerializedNode,
  SerializedState,
  VersionVector,
} from "./types";

// State helpers (high-level)
export {
  PatchError,
  createState,
  toJson,
  applyPatch,
  applyPatchInPlace,
  applyPatchAsActor,
} from "./state";

// Clock
export { createClock, cloneClock, nextDotForActor, observeDot } from "./clock";

// Document helpers
export {
  docFromJson,
  cloneDoc,
  applyIntentsToCrdt,
  jsonPatchToCrdt,
  jsonPatchToCrdtSafe,
  crdtToJsonPatch,
  crdtToFullReplace,
} from "./doc";

// Patch helpers
export {
  parseJsonPointer,
  stringifyJsonPointer,
  getAtJson,
  compileJsonPatchToIntent,
  diffJsonPatch,
  jsonEquals,
} from "./patch";

// Serialization
export { serializeDoc, deserializeDoc, serializeState, deserializeState } from "./serialize";

// Materialize
export { materialize } from "./materialize";

// Merge
export { mergeDoc, mergeState } from "./merge";
