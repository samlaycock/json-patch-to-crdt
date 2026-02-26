---
"json-patch-to-crdt": patch
---

Repair `deserializeState` clock restoration by lifting stale serialized actor counters to the
highest dot already present in the deserialized document, preventing duplicate dot generation
after restart. Includes a regression test for tampered serialized clock metadata.
