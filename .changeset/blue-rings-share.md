---
"json-patch-to-crdt": patch
---

Reduce `diffJsonPatch` object traversal allocation overhead by reusing a mutable path stack and replacing temporary key-membership `Set` allocations with sorted-key merge scans, while preserving deterministic patch ordering.
