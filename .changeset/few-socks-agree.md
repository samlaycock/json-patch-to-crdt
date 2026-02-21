---
"json-patch-to-crdt": patch
---

Prevent base-aware array intents from coercing a diverged head node into an array. Array insert/delete/replace now return a typed conflict when the head path is no longer an array, and a regression test covers this behavior.
