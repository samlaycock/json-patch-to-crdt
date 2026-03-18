---
"json-patch-to-crdt": patch
---

Compile explicit-base sequential patch steps directly from the live CRDT docs so narrow patches no longer eagerly materialize full head/base documents before the first operation, while preserving sequential move/copy/test behavior.
