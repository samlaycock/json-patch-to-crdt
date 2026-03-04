---
"json-patch-to-crdt": patch
---

Add a CRDT-native `crdtToJsonPatch` diff path that walks CRDT nodes directly instead of
materializing both documents up front. The new path skips unchanged shared subtrees, only
materializes changed regions when emitting add/replace values, and reuses JSON diffing only for
changed array regions.

Keep strict/normalize `jsonValidation` behavior compatible by falling back to the legacy
materialize-and-diff path for those modes.

Add regression coverage for subtree-skipping behavior and a dedicated CRDT diff microbenchmark
(`bun run bench:crdt-diff`) to compare native vs legacy performance on mostly unchanged large docs.
