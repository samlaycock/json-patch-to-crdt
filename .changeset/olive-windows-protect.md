---
"json-patch-to-crdt": patch
---

Fix `materialize` and `toJson` so unsafe keys like `__proto__`, `constructor`, and `prototype` are preserved as normal data keys without mutating output object prototypes.

Add regression coverage for nested object and array cases to prevent prototype mutation regressions.
