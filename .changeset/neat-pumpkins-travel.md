---
"json-patch-to-crdt": patch
---

Optimize sequential patch execution for high-level state APIs by compiling and applying no-base sequential batches in one pass instead of per-operation materialize/compile cycles.

Reduce sequential compiler overhead by reusing a mutable shadow JSON snapshot and cached parsed pointers during batch compilation, while preserving RFC 6902 semantics and error mapping.

Expand sequential microbenchmark coverage to include medium and large long-batch scenarios, and add regression coverage for long sequential add/remove programs with `testAgainst: "base"`.
