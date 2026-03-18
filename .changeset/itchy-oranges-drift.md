---
"json-patch-to-crdt": patch
---

Speed up duplicate-heavy array move/copy rewrite passes by indexing shadow-array rewrite candidates with stable structural keys instead of repeatedly rescanning the evolving array during finalize-time copy and move detection. Add regression coverage for the duplicate-heavy copy path and extend the array diff microbenchmark with duplicate-heavy append, insert, and reorder scenarios using `emitCopies` and `emitMoves`.
