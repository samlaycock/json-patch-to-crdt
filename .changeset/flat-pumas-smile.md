---
"json-patch-to-crdt": patch
---

Optimize long explicit-base sequential patch application by reusing a per-apply session for
pointer parsing, single-op intent compilation, and JSON shadow parent-path lookups. This reduces
repeated per-op overhead while preserving RFC 6902 sequential semantics.

Add explicit-base sequential microbenchmark coverage and new performance regression tests to guard
alignment behavior on long replace/test and move-heavy batches.
