---
"json-patch-to-crdt": patch
---

Deduplicate benchmark environment parsing by introducing a shared `parsePositiveIntEnv` helper used across the object diff, CRDT diff, and sequential apply microbenchmarks.
