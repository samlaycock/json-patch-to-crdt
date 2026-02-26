---
"json-patch-to-crdt": patch
---

Optimize sequential patch application to avoid repeated full JSON materialization and recursive explicit-base shadow replays, including the `move` fast path, while preserving sequential semantics.
