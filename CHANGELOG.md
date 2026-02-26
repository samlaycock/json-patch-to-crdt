# json-patch-to-crdt

## 0.2.1

### Patch Changes

- 0dc6744: Repair `deserializeState` clock restoration by lifting stale serialized actor counters to the
  highest dot already present in the deserialized document, preventing duplicate dot generation
  after restart. Includes a regression test for tampered serialized clock metadata.
- f1a9711: Reduce repeated indexed-array RGA lookups during intent application by reusing per-sequence
  index snapshots across an apply session and incrementally updating them when base and head share
  the same evolving array. Includes a perf regression test covering repeated indexed deletes on an
  evolving base snapshot.
- cc63450: Add internals RGA validation helpers and a checked insert API to detect missing predecessors, cycles, and orphaned elements in custom sequence construction.
- afe729c: Optimize array insert dot allocation by caching the max sibling insert dot per predecessor so
  repeated inserts no longer rescan the full RGA sequence. Includes a performance regression test
  covering repeated append workloads.
- a634b99: Fix sequence tombstone compaction so deleted RGA elements are only pruned when the delete event itself is causally stable.

  This stores per-element delete metadata (`delDot`) for sequence tombstones, preserves it through merge/clone/serialization, and adds regression coverage for delete -> compact -> merge without resurrection.

## 0.2.0

### Minor Changes

- b9b1785: Add `tryApplyPatchAsActor` to the internals API as a non-throwing counterpart to `applyPatchAsActor`, returning structured apply errors while preserving the existing throwing helper.

### Patch Changes

- 32bfcd6: Reduce `diffJsonPatch` object traversal allocation overhead by reusing a mutable path stack and replacing temporary key-membership `Set` allocations with sorted-key merge scans, while preserving deterministic patch ordering.
- 16878c6: Add non-throwing `tryDeserializeDoc` and `tryDeserializeState` helpers that return structured failures (including typed deserialize and max-depth errors) instead of throwing during CRDT deserialization.
- 267b31d: Improve `diffJsonPatch` array LCS scalability by trimming unchanged array prefixes/suffixes before applying the LCS matrix guardrail, allowing large arrays with small localized edits to produce index-level patches without allocating a full-size matrix.
- 68eb543: Optimize sequential JSON Patch intent compilation to avoid cloning the entire base document up front by using copy-on-write shadow updates for touched paths only.
- 99831f6: Optimize sequential patch application to avoid repeated full JSON materialization and recursive explicit-base shadow replays, including the `move` fast path, while preserving sequential semantics.
- d9fd97f: Prevent external mutation of cached `rgaLinearizeIds` output by returning a copy of the cached linearized ID list.
- 3ae0606: Reduce `materialize` traversal allocations by iterating object entries and RGA sequence elements with resumable cursors instead of snapshotting `Array.from(...)` entry lists and per-frame linearized ID arrays.
- 076c7e9: Avoid full document materialization for JSON Patch `test` intents by resolving the CRDT path directly and only materializing the matched subtree when needed, reducing repeated `test` overhead on large documents with unrelated branches.
- 1af3e6e: Reject cyclic RGA predecessor graphs during deserialization and throw a typed invariant error instead of silently dropping unreachable sequence elements.

## 0.1.3

### Patch Changes

- a5a27c3: Validate `createClock`/`createState` actor IDs and starting counters up front, throwing a typed `ClockValidationError` for empty actors and invalid counter values instead of allowing states that later fail serialization round-trips.
- 212920d: Prevent base-aware array intents from coercing diverged head nodes into arrays, and tighten base-aware `remove` so it fails when the mapped base element is missing from the current head lineage. Duplicate removals remain idempotent, while stale-lineage removals now return typed conflicts.
- d79b83e: Add a `strictParents` patch-application option that disables legacy implicit array parent creation for `ArrInsert` when the base path is missing. By default behavior remains backward compatible, while strict mode now returns `MISSING_PARENT` for missing array parents and includes regression coverage for both strict and non-strict behavior.
- 1ed9ff7: Optimize sequential patch execution for high-level state APIs by compiling and applying no-base sequential batches in one pass instead of per-operation materialize/compile cycles.

  Reduce sequential compiler overhead by reusing a mutable shadow JSON snapshot and cached parsed pointers during batch compilation, while preserving RFC 6902 semantics and error mapping.

  Expand sequential microbenchmark coverage to include medium and large long-batch scenarios, and add regression coverage for long sequential add/remove programs with `testAgainst: "base"`.

- cfc5fd1: Fix `materialize` and `toJson` so unsafe keys like `__proto__`, `constructor`, and `prototype` are preserved as normal data keys without mutating output object prototypes.

  Harden version vector helpers and CRDT serialization to safely handle dynamic keys using own-property reads and `Object.defineProperty`, preventing `__proto__`-based prototype mutation in defense-in-depth paths.

  Add regression coverage for nested object and array cases, unsafe actor IDs in version vectors, and serialization of unsafe keys.

- 788c7cf: Add regression tests for `getAtJson` to ensure inherited properties like `toString`, `hasOwnProperty`, and `__proto__` are treated as missing JSON keys.
- 0f5160d: Add optional runtime JSON guardrails for untyped inputs across `createState`, patch application/validation, and `diffJsonPatch` via `jsonValidation: "none" | "strict" | "normalize"`.

  Introduce strict runtime rejection for non-JSON values (for example `NaN`, `Infinity`, and `undefined`) and a normalize mode that coerces non-finite numbers/invalid array items to `null` while omitting invalid object-property values.

  Export `JsonValueValidationError`, document strict-vs-lenient behavior in the README, and add regression coverage for strict and normalize modes.

- 4c535ed: Fix prototype-pollution during patch compilation by limiting JSON object traversal to own properties and rejecting unsafe `__proto__` object-key writes. This prevents failed patches from mutating shared prototypes while keeping error reporting typed.

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
