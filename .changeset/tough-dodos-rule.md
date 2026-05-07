"json-patch-to-crdt": minor
---

Add configurable resource budgets across patch, diff, merge, and deserialize APIs.

This introduces shared resource-budget options and typed budget-exhaustion failures so
callers handling untrusted input can cap patch program length, breadth-oriented object
and sequence traversal, serialized payload inspection, and array diff work.
