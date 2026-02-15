# json-patch-to-crdt

## 0.1.1

### Patch Changes

- fc7d049: Ensure high-level patch APIs return typed errors for sequential `copy`/`move` source lookup failures.
  - Prevent raw `Error` throws from escaping when `from` pointers are invalid, missing, or out-of-bounds.
  - Map `copy`/`move` source parse and lookup failures to structured `ApplyError` metadata (`reason`, `path`, `opIndex`).
  - Add regression tests covering `tryApplyPatch` and `applyPatch` behavior for missing source paths, invalid source pointers, and out-of-bounds source indices.

- 18dcd31: Harden JSON Pointer and array-index parsing to match strict RFC behavior.
  - Reject invalid pointer escape sequences (anything other than `~0` and `~1`).
  - Reject leading-zero array indices (for example `/arr/01`) when resolving array paths.
  - Keep numeric-looking object keys valid when parent values are objects (for example `/obj/01`).
  - Add regression tests for invalid escapes, strict array-index parsing, and object-key compatibility.

- 52cde5b: Harden `forkState` against unsafe same-actor replica forking.
  - Reject `forkState(origin, actor)` by default when `actor` matches `origin.clock.actor`.
  - Add an explicit `allowActorReuse` opt-in for advanced workflows that intentionally reuse actor IDs.
  - Document actor uniqueness requirements and add regression tests for default rejection and explicit override behavior.

- 2650019: Fix `move` edge cases so sequential internals align with RFC 6902 and `applyPatch`.
  - Apply sequential `move` as remove-then-add in `jsonPatchToCrdt`, while capturing the source value before removal.
  - Treat self-move (`from === path`) as a no-op in sequential compilation and low-level application flow.
  - Add regression tests for forward array moves, self-move behavior, and parity between `jsonPatchToCrdt` and `applyPatch`.

## 0.1.0

### Minor Changes

- 27a3fa1: BREAKING: the main `json-patch-to-crdt` entrypoint is now intentionally high-level. Low-level CRDT primitives and advanced helpers moved to `json-patch-to-crdt/internals`.
  - Narrowed root exports to an application-focused API (`createState`, `forkState`, `applyPatch`, `mergeState`, serialization, and JSON diffing).
  - Added `forkState(origin, actor)` to simplify shared-origin replica creation without requiring clock/doc internals.
  - Split patch option/result types:
    - `ApplyPatchOptions` now targets immutable apply and no longer includes `atomic`.
    - `ApplyPatchInPlaceOptions` now owns `atomic`.
    - Added `TryApplyPatchInPlaceResult`.
  - Updated high-level patch base semantics so `applyPatch(..., { base })` expects a prior `CrdtState` snapshot.
  - Kept advanced actor/doc/intents APIs available via `json-patch-to-crdt/internals` (including `applyPatchAsActor`, `mergeDoc`, `jsonPatchToCrdt*`, and CRDT primitives).
  - Refreshed documentation and examples to reflect root-vs-internals boundaries and migration paths.
