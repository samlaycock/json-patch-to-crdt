---
"json-patch-to-crdt": patch
---

Add a `strictParents` patch-application option that disables legacy implicit array parent creation for `ArrInsert` when the base path is missing. By default behavior remains backward compatible, while strict mode now returns `MISSING_PARENT` for missing array parents and includes regression coverage for both strict and non-strict behavior.
