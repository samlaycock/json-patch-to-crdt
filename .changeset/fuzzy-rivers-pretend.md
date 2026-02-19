---
"json-patch-to-crdt": patch
---

Replace brittle lookup-error string matching with structured `JsonLookupError` types in patch path resolution.

Map typed lookup failure codes to patch failure reasons in `mapLookupErrorToPatchReason` to preserve error semantics without relying on message text.

Add targeted regression tests for invalid array-index tokens and non-container traversal to assert exact failure reason mapping.
