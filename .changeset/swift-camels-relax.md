---
"json-patch-to-crdt": patch
---

Escape merge lineage error pointers with RFC 6901 encoding so `tryMergeDoc`, `mergeDoc`, and related shared-element merge diagnostics report unambiguous paths for keys containing `/` or `~`.
