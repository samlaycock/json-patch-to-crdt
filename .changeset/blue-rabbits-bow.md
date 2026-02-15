---
"json-patch-to-crdt": patch
---

Ensure high-level patch APIs return typed errors for sequential `copy`/`move` source lookup failures.

- Prevent raw `Error` throws from escaping when `from` pointers are invalid, missing, or out-of-bounds.
- Map `copy`/`move` source parse and lookup failures to structured `ApplyError` metadata (`reason`, `path`, `opIndex`).
- Add regression tests covering `tryApplyPatch` and `applyPatch` behavior for missing source paths, invalid source pointers, and out-of-bounds source indices.
