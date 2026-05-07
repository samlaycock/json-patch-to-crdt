---
"json-patch-to-crdt": patch
---

Track observed version vectors incrementally for created, cloned, patched, and deserialized CRDT documents so stale-counter recovery no longer needs to rescan cached document trees.
