// Public API — the recommended surface for most consumers.

// Types
export type {
  ActorId,
  ApplyError,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  CrdtState,
  DiffOptions,
  JsonPatch,
  JsonPatchOp,
  JsonPrimitive,
  JsonValue,
  MergeStateOptions,
  PatchErrorReason,
  PatchSemantics,
  SerializedState,
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

// JSON helpers
export { diffJsonPatch } from "./patch";

// Serialization
export { serializeState, deserializeState } from "./serialize";

// Merge
export { MergeError, mergeState, tryMergeState } from "./merge";
