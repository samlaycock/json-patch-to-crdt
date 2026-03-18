---
"json-patch-to-crdt": patch
---

Make `diffJsonPatch` traverse deep object comparisons and move/copy source matching iteratively so deeply nested changes return patch ops or a typed `MAX_DEPTH_EXCEEDED` error instead of overflowing the JavaScript call stack.
