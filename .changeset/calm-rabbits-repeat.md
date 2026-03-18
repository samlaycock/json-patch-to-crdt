---
"json-patch-to-crdt": minor
---

Expose public version-vector inspection helpers for sync and compaction flows.

Add `observedVersionVector`, `mergeVersionVectors`, `intersectVersionVectors`,
and `versionVectorCovers` to the main API surface, and document how to use them
to derive sync checkpoints and causally-stable tombstone compaction checkpoints.
