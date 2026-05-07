---
"json-patch-to-crdt": minor
---

Add safe-by-default runtime JSON validation helpers for state creation, patch application, and JSON Patch diffs.

The new `Safe` helpers use strict validation, while the new `Normalized` helpers coerce invalid runtime values into JSON-safe output. Existing APIs keep their backward-compatible `jsonValidation: "none"` default.
