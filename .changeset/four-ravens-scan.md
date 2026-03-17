---
"json-patch-to-crdt": patch
---

Include RGA sequence delete dots when recovering actor counters during state deserialization, `applyPatchAsActor`, and `mergeState` so resumed writes do not reuse prior actor counters after array deletions.
