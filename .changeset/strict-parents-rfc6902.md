---
"json-patch-to-crdt": minor
---

Add named strict and legacy parent-semantics profiles for RFC 6902 array inserts.

`withStrictRfc6902Parents(...)` and `strictRfc6902PatchOptions` make missing array
parents fail explicitly, while `withLegacyMissingArrayParents(...)` keeps the
deprecated auto-create behavior available as an opt-in compatibility path.
