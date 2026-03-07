---
"json-patch-to-crdt": patch
---

Optimize wide-object JSON Patch diffing by collapsing object key add/remove work into fewer deterministic passes. Add regression coverage and a focused microbenchmark for large object diffs.
