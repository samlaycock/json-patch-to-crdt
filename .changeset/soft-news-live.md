---
"json-patch-to-crdt": patch
---

Reject cyclic RGA predecessor graphs during deserialization and throw a typed invariant error instead of silently dropping unreachable sequence elements.
