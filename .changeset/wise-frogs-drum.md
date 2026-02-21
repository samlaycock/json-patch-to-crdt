---
"json-patch-to-crdt": patch
---

Fix prototype-pollution during patch compilation by limiting JSON object traversal to own properties and rejecting unsafe `__proto__` object-key writes. This prevents failed patches from mutating shared prototypes while keeping error reporting typed.
