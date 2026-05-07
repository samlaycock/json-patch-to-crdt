---
"json-patch-to-crdt": minor
---

Cap `arrayStrategy: "lcs-linear"` work by default using the existing 250,000-cell unmatched-window budget.

Callers that need the previous unbounded traversal can now opt out explicitly with
`lcsLinearMaxCells: Number.POSITIVE_INFINITY`.
