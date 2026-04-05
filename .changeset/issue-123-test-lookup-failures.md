---
"json-patch-to-crdt": patch
---

Preserve typed lookup failures for `test` operations instead of collapsing
array-token and non-container traversal errors into `MISSING_TARGET`.

This keeps invalid array tokens mapped to `INVALID_POINTER`, non-container
traversal mapped to `INVALID_TARGET`, and adds regression coverage for the
Issue #123 reproductions.
