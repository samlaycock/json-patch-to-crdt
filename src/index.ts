// Public API — the recommended surface for most consumers.

// Types
export type {
  ActorId,
  AbortSignalLike,
  ApplyError,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  CreateStateOptions,
  CrdtState,
  CompactStateTombstonesResult,
  DeserializeFailure,
  DeserializeOptions,
  DiffOptions,
  DeserializeErrorReason,
  ForkStateOptions,
  JsonValidationMode,
  ResourceBudget,
  ResourceBudgetExceededFailure,
  ResourceBudgetKind,
  JsonPatch,
  JsonPatchOp,
  JsonPrimitive,
  JsonValue,
  MergeStateOptions,
  UnrelatedArraysStrategy,
  PatchErrorReason,
  PatchSemantics,
  SerializedState,
  TombstoneCompactionOptions,
  TombstoneCompactionStats,
  TryApplyPatchInPlaceResult,
  TryApplyPatchResult,
  TryDeserializeStateResult,
  TryMergeStateResult,
  ValidatePatchResult,
} from "./types";
export type {
  NormalizedApplyPatchOptions,
  NormalizedCreateStateOptions,
  NormalizedDiffOptions,
  SafeApplyPatchOptions,
  SafeCreateStateOptions,
  SafeDiffOptions,
} from "./safe";

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
export { ResourceBudgetError } from "./budget";
export { OperationCancelledError } from "./cancellation";

// JSON helpers
export { diffJsonPatch } from "./patch";

// Safe-by-default JSON validation helpers
export {
  applyNormalizedPatch,
  applySafePatch,
  createNormalizedState,
  createSafeState,
  diffNormalizedJsonPatch,
  diffSafeJsonPatch,
} from "./safe";

// Compatibility profiles
export {
  strictRfc6902PatchOptions,
  withStrictRfc6902Parents,
  withLegacyMissingArrayParents,
} from "./options";

// Serialization
export {
  DeserializeError,
  serializeState,
  deserializeState,
  tryDeserializeState,
} from "./serialize";

// Merge
export { MergeError, mergeState, tryMergeState } from "./merge";
export {
  observedVersionVector,
  mergeVersionVectors,
  intersectVersionVectors,
  versionVectorCovers,
} from "./version-vector";

// Tombstone compaction
export { compactStateTombstones } from "./compact";

// Traversal limits
export { MAX_TRAVERSAL_DEPTH, TraversalDepthError } from "./depth";
