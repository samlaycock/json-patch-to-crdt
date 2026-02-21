---
"json-patch-to-crdt": patch
---

Prevent base-aware array intents from coercing diverged head nodes into arrays, and tighten base-aware `remove` so it fails when the mapped base element is missing from the current head lineage. Duplicate removals remain idempotent, while stale-lineage removals now return typed conflicts.
