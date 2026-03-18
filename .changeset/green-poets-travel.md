---
"json-patch-to-crdt": minor
---

Add an opt-in `lcsLinearMaxCells` diff option so `arrayStrategy: "lcs-linear"` can fall back to an
atomic array `replace` when the trimmed unmatched window would otherwise trigger worst-case
`O(n * m)` work.
