---
"json-patch-to-crdt": patch
---

Fix `materialize` and `toJson` so unsafe keys like `__proto__`, `constructor`, and `prototype` are preserved as normal data keys without mutating output object prototypes.

Harden version vector helpers and CRDT serialization to safely handle dynamic keys using own-property reads and `Object.defineProperty`, preventing `__proto__`-based prototype mutation in defense-in-depth paths.

Add regression coverage for nested object and array cases, unsafe actor IDs in version vectors, and serialization of unsafe keys.
