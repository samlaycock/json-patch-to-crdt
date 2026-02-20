// Low-level internals for advanced use cases.
// Most consumers should use the main entry point instead.

// Re-export the full public API for convenience.
export * from "./index";

// Advanced state helper.
export { applyPatchAsActor } from "./state";

// Clock helpers.
export { createClock, cloneClock, nextDotForActor, observeDot } from "./clock";

// Advanced document/intent helpers.
export {
  docFromJson,
  docFromJsonWithDot,
  cloneDoc,
  applyIntentsToCrdt,
  jsonPatchToCrdt,
  jsonPatchToCrdtSafe,
  tryJsonPatchToCrdt,
  crdtToJsonPatch,
  crdtToFullReplace,
} from "./doc";

// Low-level patch helpers.
export {
  parseJsonPointer,
  stringifyJsonPointer,
  getAtJson,
  compileJsonPatchToIntent,
  PatchCompileError,
  jsonEquals,
} from "./patch";

// Node-level materialization helper.
export { materialize } from "./materialize";

// Tombstone compaction helpers.
export { compactDocTombstones, compactStateTombstones } from "./compact";

// Low-level document merge helpers.
export { mergeDoc, tryMergeDoc } from "./merge";

// Low-level document serialization helpers.
export { serializeDoc, deserializeDoc } from "./serialize";

// Internals-only types.
export type {
  ApplyPatchAsActorResult,
  ApplyPatchAsActorOptions,
  ApplyResult,
  Clock,
  CompactDocTombstonesResult,
  CompactStateTombstonesResult,
  CompilePatchOptions,
  Doc,
  Dot,
  ElemId,
  IntentOp,
  JsonPatchToCrdtOptions,
  LwwReg,
  MergeDocOptions,
  Node,
  ObjEntry,
  ObjNode,
  RgaElem,
  RgaSeq,
  SerializedClock,
  SerializedDoc,
  SerializedNode,
  SerializedRgaElem,
  TombstoneCompactionOptions,
  TombstoneCompactionStats,
  TryMergeDocResult,
  VersionVector,
} from "./types";

// Constants.
export { ROOT_KEY } from "./types";

// Dot utilities.
export { compareDot, vvHasDot, vvMerge, dotToElemId } from "./dot";

// Low-level node constructors and operations.
export { newObj, newSeq, newReg, lwwSet, objSet, objRemove, objCompactTombstones } from "./nodes";

// Low-level RGA operations.
export {
  HEAD,
  rgaInsertAfter,
  rgaDelete,
  rgaCompactTombstones,
  rgaLinearizeIds,
  rgaPrevForInsertAtIndex,
  rgaIdAtIndex,
} from "./rga";
