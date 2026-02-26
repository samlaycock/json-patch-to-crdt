---
"json-patch-to-crdt": patch
---

Avoid full document materialization for JSON Patch `test` intents by resolving the CRDT path directly and only materializing the matched subtree when needed, reducing repeated `test` overhead on large documents with unrelated branches.
