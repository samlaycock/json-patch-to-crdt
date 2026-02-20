# json-patch-to-crdt

Convert JSON Patch (RFC 6902) operations into a CRDT-friendly data structure and back to JSON.

This package is for applications that need to:

- Apply JSON Patch operations locally.
- Maintain a CRDT-compatible document model for sync.
- Merge divergent document states from multiple peers.
- Serialize and restore CRDT state safely.
- Generate JSON Patch deltas using explicit base snapshots.

It models JSON with:

- LWW registers for primitives.
- An RGA sequence for arrays.
- A map with delete-wins semantics for objects.

## Install

```bash
bun add json-patch-to-crdt
```

```bash
npm install json-patch-to-crdt
```

## Runtime Requirements

- Node.js `>= 18` (for package consumers).
- TypeScript `^5` when type-checking in your project.
- Bun is optional (used for this repo's own build/test scripts).

## Quick Start (Recommended API)

```ts
import { applyPatch, createState, toJson, type JsonPatchOp } from "json-patch-to-crdt";

const state = createState({ list: ["a", "b"], meta: { ok: true } }, { actor: "A" });

const patch: JsonPatchOp[] = [
  { op: "add", path: "/list/-", value: "c" },
  { op: "replace", path: "/meta/ok", value: false },
];

try {
  const next = applyPatch(state, patch);
  console.log(toJson(next));
} catch (err) {
  // PatchError has a `.code` you can inspect if needed.
  throw err;
}
```

## Multi-Peer Sync

Two peers can start from a shared state, apply patches independently, and merge:

```ts
import { applyPatch, createState, forkState, mergeState, toJson } from "json-patch-to-crdt";

// Both peers start from the same origin state.
const origin = createState({ count: 0, items: ["a"] }, { actor: "origin" });

// Fork shared-origin replicas with local actor identities.
// Actor IDs must be unique per live peer (same-actor reuse is rejected by default).
const peerA = forkState(origin, "A");
const peerB = forkState(origin, "B");

// Peers diverge with independent edits.
const a1 = applyPatch(peerA, [
  { op: "replace", path: "/count", value: 1 },
  { op: "add", path: "/items/-", value: "b" },
]);

const b1 = applyPatch(peerB, [
  { op: "replace", path: "/count", value: 2 },
  { op: "add", path: "/items/-", value: "c" },
]);

// Each peer merges while preserving its own actor identity.
const mergedAtA = mergeState(a1, b1, { actor: "A" });
const mergedAtB = mergeState(b1, a1, { actor: "B" });

console.log(toJson(mergedAtA));
// { count: 2, items: ["a", "c", "b"] }
// (both appends preserved; sibling order follows dot ordering)

// Both peers can continue editing safely.
const a2 = applyPatch(mergedAtA, [{ op: "replace", path: "/count", value: 3 }]);
const b2 = applyPatch(mergedAtB, [{ op: "add", path: "/items/-", value: "d" }]);

// Merge again to converge.
const converged = mergeState(a2, b2, { actor: "A" });
console.log(toJson(converged));
// { count: 3, items: ["a", "c", "b", "d"] }
```

## Concepts

- **Doc**: CRDT document node graph (primarily an internals concept).
- **State**: `{ doc, clock }`, used by the main API.
- **Base snapshot**: for `applyPatch`, pass a prior `CrdtState`; internals APIs may use raw `Doc` snapshots.

## Ordered Event Log Server Pattern

If your service contract is "JSON Patch in / JSON Patch out", and your backend keeps CRDT metadata internally:

- Keep one authoritative CRDT head per document.
- Keep a version vector keyed by actor ID.
- On each incoming JSON Patch, call `applyPatchAsActor(headDoc, vv, actor, patch, { base })`.
- Append the accepted event to your ordered log.
- For downstream clients, emit `crdtToJsonPatch(clientBaseDoc, currentHeadDoc)`.

Minimal shape (advanced API via `json-patch-to-crdt/internals`):

```ts
import {
  applyPatchAsActor,
  PatchError,
  crdtToJsonPatch,
  createState,
  type Doc,
  type JsonPatchOp,
  type VersionVector,
} from "json-patch-to-crdt/internals";

let head: Doc = createState({ list: [] }, { actor: "server" }).doc;
let vv: VersionVector = {};

function applyIncomingPatch(
  actor: string,
  base: Doc,
  patch: JsonPatchOp[],
): { ok: true; outPatch: JsonPatchOp[] } | { ok: false; code: number; message: string } {
  try {
    const applied = applyPatchAsActor(head, vv, actor, patch, { base });
    head = applied.state.doc;
    vv = applied.vv;

    // Persist incoming event and/or outPatch in your append-only ordered log.
    const outPatch = crdtToJsonPatch(base, head);
    return { ok: true, outPatch };
  } catch (error) {
    if (error instanceof PatchError) {
      return { ok: false, code: error.code, message: error.message };
    }

    throw error;
  }
}
```

If you prefer a non-throwing low-level compile+apply path, use `jsonPatchToCrdtSafe` from `json-patch-to-crdt/internals`.

## Patch Semantics

- Patches are interpreted relative to a base snapshot.
- `applyPatch` defaults to RFC-style sequential patch execution.
- You can pass an explicit base state via `applyPatch(state, patch, { base })`.
- Patch semantics are configurable: `semantics: "sequential"` (default) or `"base"`.
- In `sequential` mode with an explicit `base`, operations are interpreted against a rolling base snapshot while being applied step-by-step to the evolving head.
- Array indexes are mapped to element IDs based on the base snapshot.
- `"-"` is treated as append for array inserts.
- `test` operations can be evaluated against `head` or `base` using the `testAgainst` option.

### Semantics Modes

- `semantics: "sequential"` (default): applies operations one-by-one against the evolving head (RFC-like execution).
- `semantics: "base"`: interprets the full patch relative to one fixed snapshot.

#### Which Mode Should You Use?

| If you need...                                                            | Use                       |
| ------------------------------------------------------------------------- | ------------------------- |
| Deterministic CRDT-style replay against a known snapshot                  | `semantics: "base"`       |
| JSON Patch behavior that feels closest to RFC 6902 step-by-step execution | `semantics: "sequential"` |
| Step-by-step replay from an explicit historical base                      | `semantics: "sequential"` |

Example:

```ts
const baseMode = applyPatch(state, [{ op: "add", path: "/list/0", value: "x" }], {
  semantics: "base",
});

const sequentialMode = applyPatch(state, [{ op: "add", path: "/list/0", value: "x" }], {
  semantics: "sequential",
});
```

## Delta Patches (First-Class)

For most applications, diff JSON values directly:

```ts
import { diffJsonPatch } from "json-patch-to-crdt";

const delta = diffJsonPatch(baseJson, nextJson);
```

If you already keep CRDT documents and need doc-level deltas, use the internals entry point:

```ts
import { crdtToJsonPatch } from "json-patch-to-crdt/internals";

const delta = crdtToJsonPatch(baseDoc, headDoc);
```

If you need a full-state root `replace` patch (no delta), use internals:

```ts
import { crdtToFullReplace } from "json-patch-to-crdt/internals";

const fullPatch = crdtToFullReplace(doc);
// [{ op: "replace", path: "", value: { ... } }]
```

### Array Delta Strategy

By default, arrays are diffed with deterministic LCS edits.
To prevent pathological `O(n*m)` matrix growth on very large arrays, LCS falls back to atomic array replacement when matrix cells exceed `250_000` by default.

If you want atomic array replacement, pass `{ arrayStrategy: "atomic" }`:

```ts
const delta = diffJsonPatch(baseJson, nextJson, { arrayStrategy: "atomic" });
```

If you want to tune the LCS fallback threshold, pass `lcsMaxCells`:

```ts
const delta = diffJsonPatch(baseJson, nextJson, {
  arrayStrategy: "lcs",
  lcsMaxCells: 500_000,
});
```

Notes:

- LCS diffs are deterministic but not necessarily minimal.
- Reorders are expressed as remove/add pairs.
- LCS complexity is `O(n*m)` in time and memory.
- `lcsMaxCells` sets the matrix cap: `(base.length + 1) * (next.length + 1)`.
- Set `lcsMaxCells: Number.POSITIVE_INFINITY` to always allow LCS.

## Merging

Merge full states:

```ts
import { mergeState } from "json-patch-to-crdt";

// Merge full states (preserve local actor identity):
const mergedState = mergeState(stateA, stateB, { actor: "A" });
```

If you need low-level document-only merging, use `mergeDoc` from `json-patch-to-crdt/internals`.

By default, merge checks that non-empty arrays share lineage (common element IDs).
If you intentionally need best-effort merging of unrelated array histories, disable this guard:

```ts
import { mergeDoc } from "json-patch-to-crdt/internals";

const mergedDoc = mergeDoc(docA, docB, { requireSharedOrigin: false });
```

Resolution rules:

- **LWW registers**: the register with the higher dot wins.
- **Objects**: entries merge key-by-key; delete-wins semantics apply.
- **RGA arrays**: elements union by ID; tombstones propagate (delete wins).
- **Kind mismatch**: the node with the higher representative dot wins.

`mergeDoc` is commutative (`merge(a, b)` equals `merge(b, a)`) and idempotent.
For `mergeState`, pass the local actor explicitly (or as the first argument) so each peer keeps a stable actor ID.

## Tombstone Compaction

Long-lived documents can accumulate object/array tombstones.  
You can compact causally-stable tombstones with:

```ts
import { compactStateTombstones } from "json-patch-to-crdt";

const { state: compacted, stats } = compactStateTombstones(state, {
  stable: { A: 120, B: 98, C: 77 },
});

console.log(stats);
// { objectTombstonesRemoved: number, sequenceTombstonesRemoved: number }
```

For server-side workflows operating on raw docs, use internals:

```ts
import { compactDocTombstones } from "json-patch-to-crdt/internals";

compactDocTombstones(doc, {
  stable: checkpointVv,
  mutate: true, // optional in-place compaction
});
```

Safety conditions:

- Only compact at checkpoints that are causally stable across all peers you still merge with.
- Do not merge compacted replicas with peers that may be behind that checkpoint.
- Compaction preserves materialized JSON output for the compacted document/state.

## Serialization

```ts
import {
  createState,
  serializeState,
  deserializeState,
  applyPatch,
  toJson,
} from "json-patch-to-crdt";

const state = createState({ a: 1 }, { actor: "A" });
const payload = serializeState(state);

const restored = deserializeState(payload);
const next = applyPatch(restored, [{ op: "replace", path: "/a", value: 2 }]);

console.log(toJson(next));
```

## Supported JSON Patch Ops

- `add`, `remove`, `replace`, `move`, `copy`, `test`.
- `move` and `copy` are compiled to `add` + optional `remove` using the base snapshot.
- Object operations follow strict parent/target checks (no implicit object path creation).

## Error Handling

High-level `applyPatch` throws `PatchError` on failure and returns a new state:

```ts
import { applyPatch, PatchError } from "json-patch-to-crdt";

try {
  const next = applyPatch(state, patch);
} catch (err) {
  if (err instanceof PatchError) {
    console.error(err.code, err.reason, err.message);
  }
}
```

Non-throwing APIs (`tryApplyPatch`, `tryApplyPatchInPlace`, `tryMergeState`) return structured conflicts.
Internals helpers like `jsonPatchToCrdtSafe` and `tryMergeDoc` return the same shape:

- `{ ok: false, code: 409, reason, message, path?, opIndex? }`

## API Summary

### State helpers

- `createState(initial, { actor, start? })` - Create a new CRDT state from JSON.
- `forkState(origin, actor, options?)` - Fork a shared-origin replica with a new local actor ID. Reusing `origin` actor IDs is rejected by default (`options.allowActorReuse: true` to opt in explicitly).
- `applyPatch(state, patch, options?)` - Apply a patch immutably, returning a new state (`semantics: "sequential"` by default).
- `applyPatchInPlace(state, patch, options?)` - Apply a patch by mutating state in place (`atomic: true` by default).
- `tryApplyPatch(state, patch, options?)` - Non-throwing immutable apply (`{ ok: true, state }` or `{ ok: false, error }`).
- `tryApplyPatchInPlace(state, patch, options?)` - Non-throwing in-place apply result.
- `validateJsonPatch(baseJson, patch, options?)` - Preflight patch validation (non-mutating).
- `toJson(docOrState)` - Materialize a JSON value from a doc or state.
- `applyPatch`/`tryApplyPatch` options: `base` expects a prior `CrdtState` snapshot (not a raw doc), plus `semantics` and `testAgainst`.
- `PatchError` - Error class thrown for failed patches (`code`, `reason`, `message`, optional `path`/`opIndex`).

### Merge helpers

- `mergeState(a, b, options?)` - Merge two CRDT states (doc + clock), preserving actor identity (`options.actor`) and optional shared-origin checks.
- `tryMergeState(a, b, options?)` - Non-throwing merge-state result.
- `MergeError` - Error class thrown by throwing merge helpers.

### Patch helpers

- `diffJsonPatch(baseJson, nextJson, options?)` - Compute a JSON Patch delta between two JSON values.

### Serialization

- `serializeState(state)` / `deserializeState(payload)` - Serialize/restore a full state.

### Internals (`json-patch-to-crdt/internals`)

Advanced helpers are available via a separate entry point:

```ts
import {
  applyPatchAsActor,
  createClock,
  docFromJson,
  mergeDoc,
  jsonPatchToCrdtSafe,
  compareDot,
  rgaInsertAfter,
  HEAD,
} from "json-patch-to-crdt/internals";
```

Internals includes low-level helpers such as:

- Actor/version-vector helpers: `applyPatchAsActor`, `createClock`, `cloneClock`, `nextDotForActor`, `observeDot`.
- Doc-level APIs: `docFromJson`, `docFromJsonWithDot`, `cloneDoc`, `materialize`, `mergeDoc`, `tryMergeDoc`.
- Intent compiler/apply pipeline: `compileJsonPatchToIntent`, `applyIntentsToCrdt`, `jsonPatchToCrdt`, `jsonPatchToCrdtSafe`, `tryJsonPatchToCrdt`.
- Doc delta/serialization helpers: `crdtToJsonPatch`, `crdtToFullReplace`, `serializeDoc`, `deserializeDoc`.
- CRDT primitives/utilities: `compareDot`, `vvHasDot`, `vvMerge`, `dotToElemId`, `newObj`, `newSeq`, `newReg`, `lwwSet`, `objSet`, `objRemove`, `HEAD`, `rgaInsertAfter`, `rgaDelete`, `rgaLinearizeIds`, `rgaPrevForInsertAtIndex`, `rgaIdAtIndex`.

## Determinism

- Object key ordering in deltas is stable (sorted keys).
- LCS array diffs are deterministic.
- Repeated runs for identical inputs yield identical patches.

## FAQ / Troubleshooting

**Why did I get `PatchError` with code `409`?**
This typically means the patch could not be applied against the base snapshot. Common causes:

- Array index out of bounds relative to the base snapshot.
- `test` op failed (value mismatch).
- Base array missing for a non-append insert.

**How do I avoid `409` for arrays?**
Always pass a base state snapshot that matches the array you are patching. If the array may be missing, create the parent path explicitly before inserting into it.

**How do I get a full-state patch instead of a delta?**
Use `crdtToFullReplace(doc)` from `json-patch-to-crdt/internals`, which emits a single root `replace` patch.

**Why do array deltas look bigger than expected?**
LCS diffs are deterministic, not minimal. If you prefer one-op array replacement, use `{ arrayStrategy: "atomic" }`.

**Why did my array delta become a full `replace` even with LCS?**
For scalability, LCS falls back to atomic replacement when arrays exceed the `lcsMaxCells` guardrail (default `250_000` matrix cells). Increase `lcsMaxCells` to allow larger LCS runs.

**Does LCS guarantee the smallest patch?**
No. It is deterministic and usually compact, but not guaranteed to be minimal.

**How do I merge states from two peers?**
Use `forkState(origin, actor)` to create each peer from the same origin, then `mergeState(local, remote, { actor: localActorId })`. Each peer should keep a stable unique actor ID across merges. See the [Multi-Peer Sync](#multi-peer-sync) example above.

**Why did `forkState` throw about actor uniqueness?**
By default, `forkState` blocks reusing `origin.clock.actor` because same-actor forks can mint duplicate dots and produce order-dependent merges. If you intentionally need same-actor cloning, pass `forkState(origin, actor, { allowActorReuse: true })`.

**Why can my local counter jump after a merge?**
Array inserts that target an existing predecessor may need to outrank sibling insert dots for deterministic ordering. The library can fast-forward the local counter in constant time to avoid expensive loops, but the resulting counter value may still jump upward when merging with peers that already have high counters.

**How should I run tombstone compaction in production?**
Treat compaction as a maintenance step after a causal-stability checkpoint (for example, after all replicas acknowledge processing through a specific version vector), then compact and persist the compacted snapshot.

## Limitations

- The array materialization and insert mapping depend on a base snapshot; concurrent inserts resolve by dot order.
- Under highly skewed peer counters, local counters may jump upward after merges to preserve deterministic insert ordering.
- Merge requires both peers to have started from the same origin document so that shared elements have matching IDs.
