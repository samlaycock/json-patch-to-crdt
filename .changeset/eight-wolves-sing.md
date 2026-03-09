---
"json-patch-to-crdt": patch
---

Add opt-in `emitMoves` and `emitCopies` diff options so `diffJsonPatch` can emit deterministic RFC 6902 `move` and `copy` operations for common reorder, rename, and duplication cases without changing the default patch shape.
