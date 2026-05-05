"json-patch-to-crdt": patch
---

Avoid a second full merged-document scan when recovering the selected actor counter in `mergeState`.

`mergeState` now threads the chosen actor's highest observed counter through the merge traversal itself, preserving the existing clock recovery behavior without calling `observedVersionVector(...)` on the merged document afterward.
