# json-patch-to-crdt

## 0.1.2

### Patch Changes

- 3c364df: Bound insert dot generation under skewed counters by capping candidate attempts and returning a typed `DOT_GENERATION_EXHAUSTED` error when generation cannot progress.

  Ensure insert counter fast-forwarding is applied before candidate generation when available, and add regression coverage for skewed sibling counters without a fast-forward hook.

- 48f934e: Add tombstone compaction APIs for long-lived documents and states via `compactDocTombstones` (internals) and `compactStateTombstones` (public API).

  Prune causally-stable object tombstones and sequence tombstones that no longer anchor any live descendants, with optional in-place mutation support for server-side maintenance workflows.

  Document compaction safety conditions and add regression coverage to verify correctness and unchanged materialized semantics before/after compaction.

- 4a7f16c: Declare runtime/tooling requirements in `package.json` by adding `engines.node` (`>=18`) and `packageManager` (`bun@1.3.7`).

  Align README runtime requirements wording with package metadata for contributor tooling consistency.

- d8ead3c: Validate serialized CRDT payloads during deserialization with runtime shape checks and sequence invariants.

  Add typed `DeserializeError` failures (with `reason` and `path`) for malformed documents/states, including invalid dot/clock fields, mismatched sequence ids, and missing sequence predecessors.

- ce8051a: Replace brittle lookup-error string matching with structured `JsonLookupError` types in patch path resolution.

  Map typed lookup failure codes to patch failure reasons in `mapLookupErrorToPatchReason` to preserve error semantics without relying on message text.

  Add targeted regression tests for invalid array-index tokens and non-container traversal to assert exact failure reason mapping.

- d54e8f1: Optimize sequential patch application in `state.ts` by removing per-operation document cloning when no explicit base snapshot is provided.

  Reuse per-op materialized base JSON during sequential apply to avoid redundant `materialize(...)` calls in move/copy/single-op flows.

  Add sequential regression tests for evolving-head multi-op arrays and `testAgainst: "base"` behavior, and add a microbenchmark script (`bun run bench:sequential`) comparing optimized apply flow against a legacy per-op clone/materialize baseline.

- 40f7879: Guard deep JSON/CRDT traversals against stack overflows by using iterative traversal in core conversion paths and a shared max-depth guard.

  Add typed `MAX_DEPTH_EXCEEDED` failures for patch/merge flows and export `TraversalDepthError` plus `MAX_TRAVERSAL_DEPTH` for callers.

  Add regression coverage for deep nesting in `createState`, `applyPatch`, `materialize`, and `mergeState`.

- f95d44d: Enforce consistency checks when merging shared RGA element IDs.

  When both replicas contain the same element ID, merge now verifies that `prev` and `insDot` metadata are identical. Conflicts return typed `LINEAGE_MISMATCH` errors with path context instead of silently merging inconsistent sequence topology.

- c66b980: Modularize the test suite by splitting the monolithic `tests/crdt.test.ts` file into domain-focused suites (`state-core`, `patch-diff-doc`, `merge-compaction`, `replica-session`) with shared helpers in `tests/test-utils.ts`.

  Add a dedicated `tests/perf-regression.test.ts` suite for known hotspot regressions and add targeted test scripts in `package.json` for faster area-specific runs.

  Update README testing documentation with domain-specific test commands.

- 81f1dee: Add scalability guardrails for LCS array diffing by introducing `lcsMaxCells` in `DiffOptions`.

  When array diffing uses the LCS strategy, automatically fall back to atomic replacement if the LCS matrix would exceed the configured cell cap (default `250_000`).

  Document array diff complexity tradeoffs in the README and add regression coverage for default fallback and configurable guardrail behavior.

## 0.1.1

### Patch Changes

- fc7d049: Ensure high-level patch APIs return typed errors for sequential `copy`/`move` source lookup failures.

  - Prevent raw `Error` throws from escaping when `from` pointers are invalid, missing, or out-of-bounds.
  - Map `copy`/`move` source parse and lookup failures to structured `ApplyError` metadata (`reason`, `path`, `opIndex`).
  - Add regression tests covering `tryApplyPatch` and `applyPatch` behavior for missing source paths, invalid source pointers, and out-of-bounds source indices.

- 18dcd31: Harden JSON Pointer and array-index parsing to match strict RFC behavior.

  - Reject invalid pointer escape sequences (anything other than `~0` and `~1`).
  - Reject leading-zero array indices (for example `/arr/01`) when resolving array paths.
  - Keep numeric-looking object keys valid when parent values are objects (for example `/obj/01`).
  - Add regression tests for invalid escapes, strict array-index parsing, and object-key compatibility.

- 52cde5b: Harden `forkState` against unsafe same-actor replica forking.

  - Reject `forkState(origin, actor)` by default when `actor` matches `origin.clock.actor`.
  - Add an explicit `allowActorReuse` opt-in for advanced workflows that intentionally reuse actor IDs.
  - Document actor uniqueness requirements and add regression tests for default rejection and explicit override behavior.

- 2650019: Fix `move` edge cases so sequential internals align with RFC 6902 and `applyPatch`.
  - Apply sequential `move` as remove-then-add in `jsonPatchToCrdt`, while capturing the source value before removal.
  - Treat self-move (`from === path`) as a no-op in sequential compilation and low-level application flow.
  - Add regression tests for forward array moves, self-move behavior, and parity between `jsonPatchToCrdt` and `applyPatch`.

## 0.1.0

### Minor Changes

- 27a3fa1: BREAKING: the main `json-patch-to-crdt` entrypoint is now intentionally high-level. Low-level CRDT primitives and advanced helpers moved to `json-patch-to-crdt/internals`.
  - Narrowed root exports to an application-focused API (`createState`, `forkState`, `applyPatch`, `mergeState`, serialization, and JSON diffing).
  - Added `forkState(origin, actor)` to simplify shared-origin replica creation without requiring clock/doc internals.
  - Split patch option/result types:
    - `ApplyPatchOptions` now targets immutable apply and no longer includes `atomic`.
    - `ApplyPatchInPlaceOptions` now owns `atomic`.
    - Added `TryApplyPatchInPlaceResult`.
  - Updated high-level patch base semantics so `applyPatch(..., { base })` expects a prior `CrdtState` snapshot.
  - Kept advanced actor/doc/intents APIs available via `json-patch-to-crdt/internals` (including `applyPatchAsActor`, `mergeDoc`, `jsonPatchToCrdt*`, and CRDT primitives).
  - Refreshed documentation and examples to reflect root-vs-internals boundaries and migration paths.
