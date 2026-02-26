---
"json-patch-to-crdt": minor
---

Add `tryApplyPatchAsActor` to the internals API as a non-throwing counterpart to `applyPatchAsActor`, returning structured apply errors while preserving the existing throwing helper.
