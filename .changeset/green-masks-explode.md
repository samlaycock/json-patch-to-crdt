---
"json-patch-to-crdt": patch
---

Optimize sequential patch application in `state.ts` by removing per-operation document cloning when no explicit base snapshot is provided.

Reuse per-op materialized base JSON during sequential apply to avoid redundant `materialize(...)` calls in move/copy/single-op flows.

Add sequential regression tests for evolving-head multi-op arrays and `testAgainst: "base"` behavior, and add a microbenchmark script (`bun run bench:sequential`) comparing optimized apply flow against a legacy per-op clone/materialize baseline.
