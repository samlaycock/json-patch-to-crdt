---
"json-patch-to-crdt": patch
---

Fix sequence tombstone compaction so deleted RGA elements are only pruned when the delete event itself is causally stable.

This stores per-element delete metadata (`delDot`) for sequence tombstones, preserves it through merge/clone/serialization, and adds regression coverage for delete -> compact -> merge without resurrection.
