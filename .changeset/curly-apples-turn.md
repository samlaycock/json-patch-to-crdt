---
"json-patch-to-crdt": patch
---

Improve `diffJsonPatch` array LCS scalability by trimming unchanged array prefixes/suffixes before applying the LCS matrix guardrail, allowing large arrays with small localized edits to produce index-level patches without allocating a full-size matrix.
