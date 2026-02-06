// Low-level internals for advanced use cases.
// Most consumers should use the main entry point instead.

// Re-export the full public API for convenience
export * from "./index";

// Legacy doc creation with single dot (prefer docFromJson with nextDot function)
export { docFromJsonWithDot } from "./doc";

// Constants
export { ROOT_KEY } from "./types";

// Dot utilities
export { compareDot, vvHasDot, vvMerge, dotToElemId } from "./dot";

// Low-level node constructors and operations
export { newObj, newSeq, newReg, lwwSet, objSet, objRemove } from "./nodes";

// Low-level RGA operations
export {
  HEAD,
  rgaInsertAfter,
  rgaDelete,
  rgaLinearizeIds,
  rgaPrevForInsertAtIndex,
  rgaIdAtIndex,
} from "./rga";
