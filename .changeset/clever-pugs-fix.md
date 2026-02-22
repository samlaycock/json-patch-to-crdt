---
"json-patch-to-crdt": patch
---

Validate `createClock`/`createState` actor IDs and starting counters up front, throwing a typed `ClockValidationError` for empty actors and invalid counter values instead of allowing states that later fail serialization round-trips.
