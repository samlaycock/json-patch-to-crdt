---
"json-patch-to-crdt": patch
---

Fix mixed object/array path traversal during patch application so valid JSON Patch paths like
`/list/0/x` and `/list/0/0` work against CRDT-backed documents.

The apply layer now resolves parent paths through sequence elements instead of assuming every
intermediate segment is an object, and adds regression tests for nested object and nested array
replacements through array elements.
