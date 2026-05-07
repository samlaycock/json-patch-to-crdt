import type {
  ApplyPatchOptions,
  CreateStateOptions,
  CrdtState,
  DiffOptions,
  JsonPatchOp,
  JsonValue,
} from "./types";

import { diffJsonPatch } from "./patch";
import { applyPatch, createState } from "./state";

export interface SafeCreateStateOptions extends Omit<CreateStateOptions, "jsonValidation"> {}

export interface SafeApplyPatchOptions extends Omit<ApplyPatchOptions, "jsonValidation"> {}

export interface SafeDiffOptions extends Omit<DiffOptions, "jsonValidation"> {}

export interface NormalizedCreateStateOptions extends Omit<CreateStateOptions, "jsonValidation"> {}

export interface NormalizedApplyPatchOptions extends Omit<ApplyPatchOptions, "jsonValidation"> {}

export interface NormalizedDiffOptions extends Omit<DiffOptions, "jsonValidation"> {}

/** Create a state with strict runtime JSON validation enabled by default. */
export function createSafeState(initial: JsonValue, options: SafeCreateStateOptions): CrdtState {
  return createState(initial, { ...options, jsonValidation: "strict" });
}

/** Apply a patch with strict runtime JSON validation enabled by default. */
export function applySafePatch(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: SafeApplyPatchOptions = {},
): CrdtState {
  return applyPatch(state, patch, { ...options, jsonValidation: "strict" });
}

/** Diff JSON values with strict runtime JSON validation enabled by default. */
export function diffSafeJsonPatch(
  base: JsonValue,
  next: JsonValue,
  options: SafeDiffOptions = {},
): JsonPatchOp[] {
  return diffJsonPatch(base, next, { ...options, jsonValidation: "strict" });
}

/** Create a state with normalizing runtime JSON validation enabled by default. */
export function createNormalizedState(
  initial: JsonValue,
  options: NormalizedCreateStateOptions,
): CrdtState {
  return createState(initial, { ...options, jsonValidation: "normalize" });
}

/** Apply a patch with normalizing runtime JSON validation enabled by default. */
export function applyNormalizedPatch(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: NormalizedApplyPatchOptions = {},
): CrdtState {
  return applyPatch(state, patch, { ...options, jsonValidation: "normalize" });
}

/** Diff JSON values with normalizing runtime JSON validation enabled by default. */
export function diffNormalizedJsonPatch(
  base: JsonValue,
  next: JsonValue,
  options: NormalizedDiffOptions = {},
): JsonPatchOp[] {
  return diffJsonPatch(base, next, { ...options, jsonValidation: "normalize" });
}
