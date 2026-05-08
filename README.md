# json-patch-to-crdt

[![npm version](https://img.shields.io/npm/v/json-patch-to-crdt)](https://www.npmjs.com/package/json-patch-to-crdt)
[![License](https://img.shields.io/npm/l/json-patch-to-crdt.svg)](LICENSE.md)

Convert JSON Patch (RFC 6902) operations into a CRDT-backed state that can be merged across peers, then materialize JSON again.

Useful when you want:

- JSON Patch in/out at your app boundary
- CRDT merges internally for offline/collaborative edits
- deterministic JSON Patch diffs between snapshots

## Install

```bash
npm install json-patch-to-crdt
```

Also works with Bun / pnpm:

```bash
bun add json-patch-to-crdt
pnpm add json-patch-to-crdt
```

Node.js `>=18`.

## Quick Start

```ts
import { applyPatch, createState, toJson, type JsonPatchOp } from "json-patch-to-crdt";

const state = createState({ todos: ["write docs"], done: false }, { actor: "client-A" });

const patch: JsonPatchOp[] = [
  { op: "add", path: "/todos/-", value: "ship package" },
  { op: "replace", path: "/done", value: true },
];

const next = applyPatch(state, patch);

console.log(toJson(next));
// { todos: ["write docs", "ship package"], done: true }
```

## Merge Two Peers

```ts
import { applyPatch, createState, forkState, mergeState, toJson } from "json-patch-to-crdt";

const origin = createState({ count: 0, items: ["a"] }, { actor: "origin" });

const peerA = forkState(origin, "A");
const peerB = forkState(origin, "B");

const a1 = applyPatch(peerA, [
  { op: "replace", path: "/count", value: 1 },
  { op: "add", path: "/items/-", value: "b" },
]);

const b1 = applyPatch(peerB, [
  { op: "replace", path: "/count", value: 2 },
  { op: "add", path: "/items/-", value: "c" },
]);

const merged = mergeState(a1, b1, { actor: "A" });

console.log(toJson(merged));
// { count: 2, items: ["a", "c", "b"] }
```

## Generate JSON Patch Deltas

```ts
import { diffJsonPatch } from "json-patch-to-crdt";

const base = { profile: { name: "Sam" }, tags: ["a"] };
const next = { profile: { name: "Sam", active: true }, tags: ["a", "b"] };

const delta = diffJsonPatch(base, next);

console.log(delta);
// [
//   { op: "add", path: "/profile/active", value: true },
//   { op: "add", path: "/tags/1", value: "b" }
// ]

const reordered = diffJsonPatch(
  { tags: ["a", "b", "c"] },
  { tags: ["b", "a", "c"] },
  { arrayStrategy: "lcs", emitMoves: true },
);

console.log(reordered);
// [{ op: "move", from: "/tags/0", path: "/tags/1" }]
```

For array-heavy snapshots, `diffJsonPatch` and `crdtToJsonPatch` support:

- `arrayStrategy: "lcs"`: deterministic index-level array edits using the classic LCS matrix. This is the default.
- `arrayStrategy: "lcs-linear"`: deterministic index-level array edits using a lower-memory linear-space LCS traversal.
- `arrayStrategy: "atomic"`: replace the whole array with a single patch operation.

`lcsMaxCells` only applies to `arrayStrategy: "lcs"`. If the classic LCS matrix for the trimmed unmatched window would exceed the configured cap, the diff falls back to an atomic array `replace`.

`lcsLinearMaxCells` is the matching guardrail for `arrayStrategy: "lcs-linear"` and defaults to `250_000`. It uses the same trimmed unmatched-window estimate, but caps worst-case runtime instead of matrix allocation. When the cap is exceeded, `lcs-linear` also falls back to an atomic array `replace`. Set `lcsLinearMaxCells: Number.POSITIVE_INFINITY` only when you explicitly want the previous unbounded behavior and accept the CPU cost for large unmatched arrays.

`diffJsonPatch` keeps the existing `add`/`remove`/`replace` output by default. Set
`emitMoves` and/or `emitCopies` to opt into deterministic RFC 6902 `move`/`copy`
rewrites.

## Cancellation

Expensive high-level APIs accept an optional `signal` compatible with `AbortSignal`:
`diffJsonPatch`, `applyPatch`, `applyPatchInPlace`, `tryApplyPatch`, `tryApplyPatchInPlace`,
`mergeState`, `tryMergeState`, `deserializeState`, and `tryDeserializeState`.

Cancellation is checked at safe points between traversal steps and array-diff loop iterations.
Immutable APIs either return no result or leave the input state unchanged when cancelled. In-place
patch application with `atomic: true` keeps the same all-or-nothing behavior; with `atomic: false`,
operations already applied before cancellation remain applied. Non-throwing APIs return
`reason: "OPERATION_CANCELLED"` and throwing APIs throw their usual domain error wrappers where
applicable.

## Performance Gates

CI runs `bun run test:perf-gate` as a fixed-size performance smoke test for
the hottest paths: array diffing, merge traversal, and sequential patch
application. These gates are intentionally smaller and more stable than the
microbenchmarks in `bench/`; they fail with the measured median, sample list,
threshold, and tuning variable so regressions are actionable.

Run the gate locally before changing hot-path code:

```bash
bun run test:perf-gate
```

The default budgets are deliberately generous for shared CI. If a runner needs
environment-specific tuning, set `PERF_GATE_ARRAY_DIFF_MS`,
`PERF_GATE_MERGE_TRAVERSAL_MS`, `PERF_GATE_SEQUENTIAL_APPLY_MS`, or
`PERF_GATE_RUNS`. Use the `bench:*` scripts for deeper investigation and only
raise a gate after confirming the slowdown is intentional.

## Serialize / Restore State

```ts
import {
  applyPatch,
  createState,
  deserializeState,
  serializeState,
  validateSerializedState,
  toJson,
} from "json-patch-to-crdt";

const state = createState({ counter: 1 }, { actor: "A" });
const saved = serializeState(state);

const validation = validateSerializedState(saved);
if (!validation.ok) {
  throw new Error(`Invalid snapshot at ${validation.error.path}: ${validation.error.message}`);
}

const restored = deserializeState(saved);
const next = applyPatch(restored, [{ op: "replace", path: "/counter", value: 2 }]);

console.log(toJson(next));
// { counter: 2 }
```

Persisted snapshot compatibility:

- `serializeState(...)` emits a versioned envelope.
- `deserializeState(...)` accepts both the current versioned format and legacy unversioned snapshots.
- `validateSerializedState(...)` and `validateSerializedDoc(...)` preflight serialized payloads and return typed failures without requiring callers to catch exceptions.
- Future envelope versions are rejected until an explicit migration path is added.

The same compatibility contract applies to the lower-level `serializeDoc(...)` and
`deserializeDoc(...)` helpers. Use the validation-only helpers at trust boundaries
when you need to reject malformed snapshots before restoring runtime state; use
`deserializeState(...)` or `deserializeDoc(...)` after validation passes when you
need the CRDT data structures.

### Resource Budgets for Serialized Payloads

When accepting serialized CRDT payloads from network clients, pass
`resourceBudget` limits to `deserializeState(...)`, `deserializeDoc(...)`, or the
non-throwing `tryDeserialize*` variants. These limits reject hostile shallow
payloads before validation allocates large maps or walks excessive element sets.

```ts
const result = tryDeserializeState(payload, {
  resourceBudget: {
    objectEntries: 10_000,
    sequenceElements: 50_000,
    serializedElements: 100_000,
    visitedNodes: 100_000,
  },
});
```

Tune these caps to your product limits. For network-exposed services, start with
caps near the largest document you intend to accept and lower them where request
size, latency, or memory limits are tighter. `objectEntries` covers object keys
and tombstone maps, `sequenceElements` covers RGA sequence elements and JSON
arrays, `serializedElements` caps the combined serialized breadth, and
`visitedNodes` caps total decoded node/value traversal.

## Error Handling

`applyPatch` throws `PatchError` when a patch cannot be applied.

```ts
import { PatchError, applyPatch } from "json-patch-to-crdt";

try {
  applyPatch(state, patch);
} catch (error) {
  if (error instanceof PatchError) {
    console.error(error.code, error.reason, error.message);
  }
}
```

If you prefer non-throwing results, use `tryApplyPatch(...)` / `tryMergeState(...)`.

## Strict Parent Semantics

RFC 6902 requires the parent of an `add` target to already exist. For compatibility
with older CRDT intent flows, missing array parents can still be materialized for
`/path/0` and `/path/-` inserts when `strictParents` is explicitly disabled.

Use the named strict profile for RFC 6902 boundaries:

```ts
import { applyPatch, createState, withStrictRfc6902Parents } from "json-patch-to-crdt";

const base = createState({}, { actor: "A" });
const head = applyPatch(base, [{ op: "add", path: "/items", value: [] }]);

applyPatch(head, [{ op: "add", path: "/items/0", value: "x" }], withStrictRfc6902Parents({ base }));
// throws PatchError: base array missing at /items
```

The error is based on the explicit `base` snapshot used for CRDT array index
resolution. In this example, `base` predates `/items`; without `{ base }`, the
current `head` state would be used as the base and the insert would succeed.

Callers that intentionally depend on the legacy auto-create behavior should opt
in explicitly with `withLegacyMissingArrayParents(...)`. That compatibility
profile is deprecated because accepting missing parents can hide invalid upstream
patch generation.

## Version Vector Helpers

`observedVersionVector(...)` lets you inspect the highest observed counter per
actor from either a `Doc` or a `CrdtState`. Use `mergeVersionVectors(...)` to
union peer observations, and `intersectVersionVectors(...)` when you need a
causally-stable checkpoint that every replica has already seen.

```ts
import {
  compactStateTombstones,
  intersectVersionVectors,
  mergeVersionVectors,
  observedVersionVector,
  versionVectorCovers,
} from "json-patch-to-crdt";

const seenByReplicaA = observedVersionVector(replicaA);
const seenByReplicaB = observedVersionVector(replicaB);

const mergedCheckpoint = mergeVersionVectors(seenByReplicaA, seenByReplicaB);
const stableCheckpoint = intersectVersionVectors(seenByReplicaA, seenByReplicaB);

if (versionVectorCovers(mergedCheckpoint, stableCheckpoint)) {
  const compacted = compactStateTombstones(state, { stable: stableCheckpoint });
}
```

Use `mergeVersionVectors(...)` for sync-style "what has this cluster observed?"
bookkeeping. Use `intersectVersionVectors(...)` for tombstone compaction
checkpoints, because compaction is only safe once every live peer covers the
same delete dots. If you call `intersectVersionVectors(...)` with a single
vector, it returns that vector unchanged.

## Runtime JSON Validation

`createState`, `applyPatch`, `diffJsonPatch`, and `crdtToJsonPatch` accept a
`jsonValidation` option for callers that may pass runtime values through `any`.
The default remains `"none"` for backward compatibility with earlier releases.

- `"none"` keeps the current behavior with no extra runtime validation.
- `"strict"` rejects values that are not valid JSON, including non-finite
  numbers, `undefined`, and non-plain objects such as `Date`, `Map`, `Set`,
  `RegExp`, typed arrays, and class instances.
- `"normalize"` coerces invalid values into JSON-safe output. Non-finite
  numbers become `null`. Non-plain objects also become `null` at the root or
  inside arrays, and are omitted from object properties.

```ts
import { createState, toJson } from "json-patch-to-crdt";

const unsafeInput = {
  keep: true,
  nested: { when: new Date("2020-01-01") },
  arr: [new Uint8Array([1, 2, 3])],
} as any;

const state = createState(unsafeInput, { actor: "A", jsonValidation: "normalize" });

console.log(toJson(state));
// { keep: true, nested: {}, arr: [null] }
```

For new untrusted-input boundaries, prefer the safe convenience helpers instead
of relying on every call site to remember `jsonValidation`.

```ts
import {
  applySafePatch,
  createNormalizedState,
  createSafeState,
  diffSafeJsonPatch,
} from "json-patch-to-crdt";

const strictState = createSafeState(inputFromApi, { actor: "A" });
const strictNext = applySafePatch(strictState, patchFromApi);
const strictDelta = diffSafeJsonPatch(previousSnapshot, nextSnapshot);

const normalizedState = createNormalizedState(inputFromApi, { actor: "A" });
```

The `Safe` helpers use strict validation and reject invalid runtime values. The
`Normalized` helpers use normalization and coerce invalid runtime values into
JSON-safe output. Existing `createState`, `applyPatch`, and `diffJsonPatch`
calls keep their current compatibility defaults unless you opt into a validation
mode directly.

## API Overview

Main exports most apps need:

- `createState(initial, { actor })`
- `createSafeState(initial, { actor })` / `createNormalizedState(initial, { actor })`
- `forkState(origin, actor)`
- `applyPatch(state, patch, options?)`
- `applySafePatch(state, patch, options?)` / `applyNormalizedPatch(state, patch, options?)`
- `tryApplyPatch(state, patch, options?)`
- `mergeState(local, remote, { actor })`
- `tryMergeState(local, remote, options?)`
- `observedVersionVector(stateOrDoc)`
- `mergeVersionVectors(...vectors)`
- `intersectVersionVectors(...vectors)`
- `versionVectorCovers(observed, required)`
- `compactStateTombstones(state, { stable })`
- `toJson(stateOrDoc)`
- `diffJsonPatch(baseJson, nextJson, options?)`
- `diffSafeJsonPatch(baseJson, nextJson, options?)` / `diffNormalizedJsonPatch(baseJson, nextJson, options?)`
- `serializeState(state)` / `deserializeState(payload)`
- `validateSerializedState(payload)` / `validateSerializedDoc(payload)`
- `validateJsonPatch(baseJson, patch, options?)`

Advanced/internal helpers are available from:

```ts
import { crdtToJsonPatch, applyPatchAsActor } from "json-patch-to-crdt/internals";
```

`docFromJsonWithDot(...)` remains available on `./internals` as a deprecated legacy
fixture helper. It reuses a single seed dot across object nodes and synthesizes
array child counters from that seed, so production code should prefer
`docFromJson(value, nextDot)`.

## Notes

- Arrays use a CRDT sequence internally; concurrent inserts are preserved.
- Patches are interpreted relative to a snapshot (RFC-style sequential execution by default).
- Merge assumes replicas come from the same origin state (use `forkState`).
- Persisted CRDT snapshots currently use envelope version `1`; legacy unversioned snapshots remain readable.

## License

MIT
