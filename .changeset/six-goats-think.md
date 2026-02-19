---
"json-patch-to-crdt": patch
---

Enforce consistency checks when merging shared RGA element IDs.

When both replicas contain the same element ID, merge now verifies that `prev` and `insDot` metadata are identical. Conflicts return typed `LINEAGE_MISMATCH` errors with path context instead of silently merging inconsistent sequence topology.
