---
"json-patch-to-crdt": patch
---

Avoid cloning `materialize` observer path arrays unless the test-only materialize observer is installed, and add a regression test that guards the hot path against observer-only path allocation work.
