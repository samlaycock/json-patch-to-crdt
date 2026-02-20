---
"json-patch-to-crdt": patch
---

Add tombstone compaction APIs for long-lived documents and states via `compactDocTombstones` (internals) and `compactStateTombstones` (public API).

Prune causally-stable object tombstones and sequence tombstones that no longer anchor any live descendants, with optional in-place mutation support for server-side maintenance workflows.

Document compaction safety conditions and add regression coverage to verify correctness and unchanged materialized semantics before/after compaction.
