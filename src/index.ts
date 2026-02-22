// Public API — the recommended surface for most consumers.

// Types
export type {
  ActorId,
  ApplyError,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  CreateStateOptions,
  CrdtState,
  CompactStateTombstonesResult,
  DiffOptions,
  DeserializeErrorReason,
  ForkStateOptions,
  JsonValidationMode,
  JsonPatch,
  JsonPatchOp,
  JsonPrimitive,
  JsonValue,
  MergeStateOptions,
  PatchErrorReason,
  PatchSemantics,
  SerializedState,
  TombstoneCompactionOptions,
  TombstoneCompactionStats,
  TryApplyPatchInPlaceResult,
  TryApplyPatchResult,
  TryMergeStateResult,
  ValidatePatchResult,
} from "./types";

// State helpers (high-level)
export {
  PatchError,
  createState,
  forkState,
  toJson,
  applyPatch,
  applyPatchInPlace,
  tryApplyPatch,
  tryApplyPatchInPlace,
  validateJsonPatch,
} from "./state";

export { JsonValueValidationError } from "./json-value";
export { ClockValidationError } from "./clock";

// JSON helpers
export { diffJsonPatch } from "./patch";

// Serialization
export { DeserializeError, serializeState, deserializeState } from "./serialize";

// Merge
export { MergeError, mergeState, tryMergeState } from "./merge";

// Tombstone compaction
export { compactStateTombstones } from "./compact";

// Traversal limits
export { MAX_TRAVERSAL_DEPTH, TraversalDepthError } from "./depth";
