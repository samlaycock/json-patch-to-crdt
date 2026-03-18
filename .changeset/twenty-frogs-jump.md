---
"json-patch-to-crdt": patch
---

Reduce object move/copy rewrite overhead in `diffJsonPatch` by memoizing
stable structural fingerprints and bucketing deterministic copy sources.

Add regression coverage for memoized structural keys and wide nested
object rename/duplicate rewrites, plus a dedicated nested rewrite
microbenchmark in `bench:object-diff`.
