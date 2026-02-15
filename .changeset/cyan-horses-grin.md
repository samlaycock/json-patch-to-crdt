---
"json-patch-to-crdt": patch
---

Harden JSON Pointer and array-index parsing to match strict RFC behavior.

- Reject invalid pointer escape sequences (anything other than `~0` and `~1`).
- Reject leading-zero array indices (for example `/arr/01`) when resolving array paths.
- Keep numeric-looking object keys valid when parent values are objects (for example `/obj/01`).
- Add regression tests for invalid escapes, strict array-index parsing, and object-key compatibility.
