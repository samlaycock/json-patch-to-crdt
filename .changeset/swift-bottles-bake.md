---
"json-patch-to-crdt": patch
---

Optimize array insert dot allocation by caching the max sibling insert dot per predecessor so
repeated inserts no longer rescan the full RGA sequence. Includes a performance regression test
covering repeated append workloads.
