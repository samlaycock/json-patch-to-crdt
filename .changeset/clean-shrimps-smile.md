---
"json-patch-to-crdt": patch
---

Add non-throwing `tryDeserializeDoc` and `tryDeserializeState` helpers that return structured failures (including typed deserialize and max-depth errors) instead of throwing during CRDT deserialization.
