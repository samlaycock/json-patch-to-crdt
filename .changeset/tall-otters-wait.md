---
"json-patch-to-crdt": minor
---

Add a new `arrayStrategy: "lcs-linear"` diff mode that uses a lower-memory linear-space LCS
traversal for array patches, preserving deterministic output across repeated runs while avoiding
the classic LCS matrix guardrail on larger unmatched windows.

Document the new array diff option, add regression coverage for large-array and CRDT delta cases,
and include an array diff microbenchmark that compares the classic matrix-backed strategy with the
new linear-space mode.
