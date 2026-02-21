---
"json-patch-to-crdt": patch
---

Add regression tests for `getAtJson` to ensure inherited properties like `toString`, `hasOwnProperty`, and `__proto__` are treated as missing JSON keys.
