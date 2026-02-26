---
"json-patch-to-crdt": patch
---

Reduce `materialize` traversal allocations by iterating object entries and RGA sequence elements with resumable cursors instead of snapshotting `Array.from(...)` entry lists and per-frame linearized ID arrays.
