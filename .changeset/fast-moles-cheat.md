---
"json-patch-to-crdt": patch
---

Validate serialized CRDT payloads during deserialization with runtime shape checks and sequence invariants.

Add typed `DeserializeError` failures (with `reason` and `path`) for malformed documents/states, including invalid dot/clock fields, mismatched sequence ids, and missing sequence predecessors.
