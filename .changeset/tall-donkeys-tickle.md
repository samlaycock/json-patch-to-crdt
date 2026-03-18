---
"json-patch-to-crdt": patch
---

Reject non-plain objects during strict runtime JSON validation and normalize them consistently to `null` or omitted object properties. Add regression coverage for `Date`, `Map`, `Set`, `RegExp`, typed arrays, and class instances, and document the runtime normalization behavior.
