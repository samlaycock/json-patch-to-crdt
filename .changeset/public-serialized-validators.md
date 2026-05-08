---
"json-patch-to-crdt": minor
---

Expose public validation-only helpers for serialized CRDT docs and states.

The new `validateSerializedDoc` and `validateSerializedState` APIs return typed validation failures without requiring callers to catch deserialization exceptions.
