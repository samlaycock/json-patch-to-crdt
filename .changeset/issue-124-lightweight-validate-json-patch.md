---
"json-patch-to-crdt": patch
---

Optimize `validateJsonPatch` to use a private in-place validation path and avoid the extra immutable clone when validating patches against JSON input.
