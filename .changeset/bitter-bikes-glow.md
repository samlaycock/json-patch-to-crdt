---
"json-patch-to-crdt": patch
---

Bound insert dot generation under skewed counters by capping candidate attempts and returning a typed `DOT_GENERATION_EXHAUSTED` error when generation cannot progress.

Ensure insert counter fast-forwarding is applied before candidate generation when available, and add regression coverage for skewed sibling counters without a fast-forward hook.
