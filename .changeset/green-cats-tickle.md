---
"json-patch-to-crdt": patch
---

Reduce repeated indexed-array RGA lookups during intent application by reusing per-sequence
index snapshots across an apply session and incrementally updating them when base and head share
the same evolving array. Includes a perf regression test covering repeated indexed deletes on an
evolving base snapshot.
