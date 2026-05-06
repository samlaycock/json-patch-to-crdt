---
"json-patch-to-crdt": minor
---

Add configurable `unrelatedArrays` merge strategy for non-overlapping array sequences.

The existing `requireSharedOrigin` boolean was too coarse for real integrations: callers had
to choose between rejecting all unrelated arrays or accepting the current unsafe-union semantics.

This change introduces an explicit `UnrelatedArraysStrategy` type with three values:

- `"reject"` – abort the merge with a `LINEAGE_MISMATCH` error (the default, identical to `requireSharedOrigin: true`)
- `"atomic-replace"` – replace the losing array entirely with the one that has the higher representative dot (causal last-write-wins at the array level), keeping merge results deterministic across peers
- `"unsafe-union"` – union all elements without a lineage check (equivalent to the old `requireSharedOrigin: false`)

The new option is available on both `MergeDocOptions` and `MergeStateOptions`. When `unrelatedArrays`
is set it takes precedence over the now-deprecated `requireSharedOrigin` boolean, which is kept for
backwards compatibility.

The `atomic-replace` strategy is applied recursively at each array node in the document tree, so
nested unrelated arrays inside objects are also handled correctly.
