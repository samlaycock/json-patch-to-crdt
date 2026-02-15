---
"json-patch-to-crdt": patch
---

Fix `move` edge cases so sequential internals align with RFC 6902 and `applyPatch`.

- Apply sequential `move` as remove-then-add in `jsonPatchToCrdt`, while capturing the source value before removal.
- Treat self-move (`from === path`) as a no-op in sequential compilation and low-level application flow.
- Add regression tests for forward array moves, self-move behavior, and parity between `jsonPatchToCrdt` and `applyPatch`.
