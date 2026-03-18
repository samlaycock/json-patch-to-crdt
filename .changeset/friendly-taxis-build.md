---
"json-patch-to-crdt": minor
---

Version serialized CRDT document and state envelopes for persistence. `serializeDoc(...)` and
`serializeState(...)` now emit `version: 1`, while `deserializeDoc(...)` and
`deserializeState(...)` continue to accept legacy unversioned payloads and reject unknown future
envelope versions until migrations are added.
