---
"json-patch-to-crdt": patch
---

Modularize the test suite by splitting the monolithic `tests/crdt.test.ts` file into domain-focused suites (`state-core`, `patch-diff-doc`, `merge-compaction`, `replica-session`) with shared helpers in `tests/test-utils.ts`.

Add a dedicated `tests/perf-regression.test.ts` suite for known hotspot regressions and add targeted test scripts in `package.json` for faster area-specific runs.

Update README testing documentation with domain-specific test commands.
