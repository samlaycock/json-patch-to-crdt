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
import {
  applyPatch,
  cloneDoc,
  createClock,
  createState,
  mergeState,
  toJson,
  type CrdtState,
} from "json-patch-to-crdt";

// Both peers start from the same origin state.
const origin = createState({ count: 0, items: ["a"] }, { actor: "origin" });

// Each peer gets a clone of the document with its own clock.
const peerA: CrdtState = {
  doc: cloneDoc(origin.doc),
  clock: createClock("A", origin.clock.ctr),
};
const peerB: CrdtState = {
  doc: cloneDoc(origin.doc),
  clock: createClock("B", origin.clock.ctr),
};

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

- **Doc**: CRDT document node graph.
- **State**: `{ doc, clock }`, where `clock` yields new dots.
- **Base snapshot**: explicit JSON or CRDT doc used to interpret array indices and compute deltas.

## Ordered Event Log Server Pattern

If your service contract is "JSON Patch in / JSON Patch out", and your backend keeps CRDT metadata internally:

- Keep one authoritative CRDT head per document.
- Keep a version vector keyed by actor ID.
- On each incoming JSON Patch, call `applyPatchAsActor(headDoc, vv, actor, patch, { base })`.
- Append the accepted event to your ordered log.
- For downstream clients, emit `crdtToJsonPatch(clientBaseDoc, currentHeadDoc)`.

Minimal shape:

```ts
import {
  applyPatchAsActor,
  PatchError,
  crdtToJsonPatch,
  createState,
  type Doc,
  type JsonPatchOp,
  type VersionVector,
} from "json-patch-to-crdt";

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

If you prefer a non-throwing low-level compile+apply path, use `jsonPatchToCrdtSafe`.

## Patch Semantics

- Patches are interpreted relative to a base snapshot.
- `applyPatch` defaults to a safe snapshot of the current state as its base.
- You can pass an explicit base doc via `applyPatch(state, patch, { base })`.
- Patch semantics are configurable: `semantics: "base"` (default) or `"sequential"`.
- In `sequential` mode with an explicit `base`, operations are interpreted against a rolling base snapshot while being applied step-by-step to the evolving head.
- Array indexes are mapped to element IDs based on the base snapshot.
- `"-"` is treated as append for array inserts.
- Missing arrays in the base snapshot only allow inserts at index `0` or `"-"`; other indexes throw a `PatchError` with code `409`.
- `test` operations can be evaluated against `head` or `base` using the `testAgainst` option.

### Semantics Modes

- `semantics: "base"` (default): interprets the full patch relative to one fixed snapshot.
- `semantics: "sequential"`: applies operations one-by-one against the evolving head (closest to RFC 6902 execution style).

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

If you want a JSON Patch delta, you must provide a base snapshot. This is a first-class API:

```ts
import { crdtToJsonPatch } from "json-patch-to-crdt";

const delta = crdtToJsonPatch(baseDoc, headDoc);
```

You can also diff JSON directly:

```ts
import { diffJsonPatch } from "json-patch-to-crdt";

const delta = diffJsonPatch(baseJson, nextJson);
```

If you need a full-state root `replace` patch (no delta), use `crdtToFullReplace`:

```ts
import { crdtToFullReplace } from "json-patch-to-crdt";

const fullPatch = crdtToFullReplace(doc);
// [{ op: "replace", path: "", value: { ... } }]
```

### Array Delta Strategy

By default, arrays are diffed with deterministic LCS edits.

If you want atomic array replacement, pass `{ arrayStrategy: "atomic" }`:

```ts
const delta = crdtToJsonPatch(baseDoc, headDoc, { arrayStrategy: "atomic" });
```

Notes:

- LCS diffs are deterministic but not necessarily minimal.
- Reorders are expressed as remove/add pairs.

## Merging

Merge two divergent CRDT documents or states:

```ts
import { mergeDoc, mergeState } from "json-patch-to-crdt";

// Merge documents (low-level):
const mergedDoc = mergeDoc(docA, docB);

// Merge full states (preserve local actor identity):
const mergedState = mergeState(stateA, stateB, { actor: "A" });
```

By default, merge checks that non-empty arrays share lineage (common element IDs).
If you intentionally need best-effort merging of unrelated array histories, disable this guard:

```ts
const mergedDoc = mergeDoc(docA, docB, { requireSharedOrigin: false });
```

Resolution rules:

- **LWW registers**: the register with the higher dot wins.
- **Objects**: entries merge key-by-key; delete-wins semantics apply.
- **RGA arrays**: elements union by ID; tombstones propagate (delete wins).
- **Kind mismatch**: the node with the higher representative dot wins.

`mergeDoc` is commutative (`merge(a, b)` equals `merge(b, a)`) and idempotent.
For `mergeState`, pass the local actor explicitly (or as the first argument) so each peer keeps a stable actor ID.

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
    console.error(err.code, err.message);
  }
}
```

Low-level APIs (`applyIntentsToCrdt`, `jsonPatchToCrdt`) return `{ ok: false, code: 409, message }` for apply-time conflicts.
Compile-time patch issues (invalid pointers, missing object parents/targets) throw errors unless you use `jsonPatchToCrdtSafe`.

## API Summary

### State helpers

- `createState(initial, { actor, start? })` - Create a new CRDT state from JSON.
- `applyPatch(state, patch, options?)` - Apply a patch immutably, returning a new state (`semantics: "base"` by default).
- `applyPatchInPlace(state, patch, options?)` - Apply a patch by mutating state in place (atomic by default, `atomic: false` for legacy behavior).
- `applyPatchAsActor(doc, vv, actor, patch, options?)` - Apply a patch for a server-tracked actor and return updated `{ state, vv }`.
- `toJson(docOrState)` - Materialize a JSON value from a doc or state.
- `PatchError` - Error class thrown for failed patches (code `409`).

### Clock helpers

- `createClock(actor, start?)` - Create a new clock for dot generation.
- `cloneClock(clock)` - Clone a clock independently.
- `nextDotForActor(vv, actor)` - Generate a dot for any actor from a shared version-vector map.
- `observeDot(vv, dot)` - Record observed dots into that map.

### Document helpers

- `docFromJson(value, nextDot)` - Create a CRDT doc using fresh dots per node.
- `cloneDoc(doc)` - Deep-clone a document.
- `materialize(node)` - Convert a CRDT node to a JSON value.

### Merge helpers

- `mergeDoc(a, b, options?)` - Merge two CRDT documents (`options.requireSharedOrigin` defaults to `true`).
- `mergeState(a, b, options?)` - Merge two CRDT states (doc + clock), preserving actor identity (`options.actor`) and optional shared-origin checks.

### Patch helpers

- `compileJsonPatchToIntent(baseJson, patch)` - Compile JSON Patch to intent operations.
- `applyIntentsToCrdt(base, head, intents, newDot, evalTestAgainst?, bumpCounterAbove?)` - Apply intents to a document.
- `jsonPatchToCrdt(base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?)` - Compile and apply in one step.
- `jsonPatchToCrdtSafe(base, head, patch, newDot, evalTestAgainst?, bumpCounterAbove?)` - Safe compile+apply wrapper that returns `409` results instead of throwing on compile-time patch issues.
- `diffJsonPatch(baseJson, nextJson, options?)` - Compute a JSON Patch delta between two JSON values.
- `crdtToJsonPatch(baseDoc, headDoc, options?)` - Compute a JSON Patch delta between two CRDT docs.
- `crdtToFullReplace(doc)` - Emit a full-state root `replace` patch.

### Serialization

- `serializeDoc(doc)` / `deserializeDoc(payload)` - Serialize/restore a document.
- `serializeState(state)` / `deserializeState(payload)` - Serialize/restore a full state.

### Internals (`json-patch-to-crdt/internals`)

Low-level helpers are available via a separate entry point for advanced use:

```ts
import { compareDot, rgaInsertAfter, objSet, HEAD } from "json-patch-to-crdt/internals";
```

This includes: `compareDot`, `vvHasDot`, `vvMerge`, `dotToElemId`, `newObj`, `newSeq`, `newReg`, `lwwSet`, `objSet`, `objRemove`, `HEAD`, `rgaInsertAfter`, `rgaDelete`, `rgaLinearizeIds`, `rgaPrevForInsertAtIndex`, `rgaIdAtIndex`, `docFromJsonWithDot`.

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
Always pass a base snapshot that matches the array you are patching. If the array may be missing, only insert at index `0` or `"-"` (append) to allow auto-creation.

**How do I get a full-state patch instead of a delta?**
Use `crdtToFullReplace(doc)` which emits a single root `replace` patch.

**Why do array deltas look bigger than expected?**
LCS diffs are deterministic, not minimal. If you prefer one-op array replacement, use `{ arrayStrategy: "atomic" }`.

**Does LCS guarantee the smallest patch?**
No. It is deterministic and usually compact, but not guaranteed to be minimal.

**How do I merge states from two peers?**
Use `mergeState(local, remote, { actor: localActorId })`. Both peers should start from a shared origin state (same document, different clocks), and each peer should keep its own unique actor ID across merges. See the [Multi-Peer Sync](#multi-peer-sync) example above.

**Why can my local counter jump after a merge?**
Array inserts that target an existing predecessor may need to outrank sibling insert dots for deterministic ordering. The library can fast-forward the local counter in constant time to avoid expensive loops, but the resulting counter value may still jump upward when merging with peers that already have high counters.

## Limitations

- The array materialization and insert mapping depend on a base snapshot; concurrent inserts resolve by dot order.
- Under highly skewed peer counters, local counters may jump upward after merges to preserve deterministic insert ordering.
- Merge requires both peers to have started from the same origin document so that shared elements have matching IDs.
