---
"json-patch-to-crdt": patch
---

Guard deep JSON/CRDT traversals against stack overflows by using iterative traversal in core conversion paths and a shared max-depth guard.

Add typed `MAX_DEPTH_EXCEEDED` failures for patch/merge flows and export `TraversalDepthError` plus `MAX_TRAVERSAL_DEPTH` for callers.

Add regression coverage for deep nesting in `createState`, `applyPatch`, `materialize`, and `mergeState`.
