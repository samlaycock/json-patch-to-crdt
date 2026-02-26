---
"json-patch-to-crdt": patch
---

Optimize sequential JSON Patch intent compilation to avoid cloning the entire base document up front by using copy-on-write shadow updates for touched paths only.
