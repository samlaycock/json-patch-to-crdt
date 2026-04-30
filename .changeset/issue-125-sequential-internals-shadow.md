---
"json-patch-to-crdt": patch
---

Optimize `jsonPatchToCrdt` sequential compilation so it resolves paths directly from the rolling CRDT document view instead of materializing the full shadow document for each operation, and add a regression test that guards against rematerializing unrelated branches.
