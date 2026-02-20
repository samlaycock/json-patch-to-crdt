---
"json-patch-to-crdt": patch
---

Add scalability guardrails for LCS array diffing by introducing `lcsMaxCells` in `DiffOptions`.

When array diffing uses the LCS strategy, automatically fall back to atomic replacement if the LCS matrix would exceed the configured cell cap (default `250_000`).

Document array diff complexity tradeoffs in the README and add regression coverage for default fallback and configurable guardrail behavior.
