import type { ApplyPatchOptions } from "./types";

/** Options that reject legacy missing-parent array auto-creation. */
export const strictRfc6902PatchOptions = {
  strictParents: true,
} as const satisfies Pick<ApplyPatchOptions, "strictParents">;

/**
 * Build `applyPatch` options for strict RFC 6902 parent semantics.
 *
 * Use this when patches come from an RFC 6902 boundary and missing array
 * parents should fail instead of being materialized.
 */
export function withStrictRfc6902Parents(): typeof strictRfc6902PatchOptions;
export function withStrictRfc6902Parents<T extends ApplyPatchOptions>(
  options: T,
): T & typeof strictRfc6902PatchOptions;
export function withStrictRfc6902Parents<T extends ApplyPatchOptions>(
  options?: T,
): typeof strictRfc6902PatchOptions | (T & typeof strictRfc6902PatchOptions) {
  return {
    ...options,
    strictParents: true,
  };
}

/**
 * Build `applyPatch` options for the legacy missing-parent array behavior.
 *
 * @deprecated Missing-parent array auto-creation is not RFC 6902 compatible.
 * Prefer `withStrictRfc6902Parents(...)` unless you are preserving legacy data
 * flows that intentionally materialize missing arrays for `/path/0` or
 * `/path/-` inserts.
 */
export function withLegacyMissingArrayParents(): { strictParents: false };
export function withLegacyMissingArrayParents<T extends ApplyPatchOptions>(
  options: T,
): T & { strictParents: false };
export function withLegacyMissingArrayParents<T extends ApplyPatchOptions>(
  options?: T,
): { strictParents: false } | (T & { strictParents: false }) {
  return {
    ...options,
    strictParents: false,
  };
}
