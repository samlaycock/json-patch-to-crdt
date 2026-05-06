---
"json-patch-to-crdt": patch
---

Deprecate `docFromJsonWithDot(...)` on the `./internals` surface and document why
production callers should prefer `docFromJson(value, nextDot)` for unique causal
metadata.
