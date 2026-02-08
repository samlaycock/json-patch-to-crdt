---
"json-patch-to-crdt": minor
---

BREAKING: the main `json-patch-to-crdt` entrypoint is now intentionally high-level. Low-level CRDT primitives and advanced helpers moved to `json-patch-to-crdt/internals`.

- Narrowed root exports to an application-focused API (`createState`, `forkState`, `applyPatch`, `mergeState`, serialization, and JSON diffing).
- Added `forkState(origin, actor)` to simplify shared-origin replica creation without requiring clock/doc internals.
- Split patch option/result types:
  - `ApplyPatchOptions` now targets immutable apply and no longer includes `atomic`.
  - `ApplyPatchInPlaceOptions` now owns `atomic`.
  - Added `TryApplyPatchInPlaceResult`.
- Updated high-level patch base semantics so `applyPatch(..., { base })` expects a prior `CrdtState` snapshot.
- Kept advanced actor/doc/intents APIs available via `json-patch-to-crdt/internals` (including `applyPatchAsActor`, `mergeDoc`, `jsonPatchToCrdt*`, and CRDT primitives).
- Refreshed documentation and examples to reflect root-vs-internals boundaries and migration paths.
