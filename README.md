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

const state = createState(
  { todos: ["write docs"], done: false },
  { actor: "client-A" },
);

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
```

## Serialize / Restore State

```ts
import {
  applyPatch,
  createState,
  deserializeState,
  serializeState,
  toJson,
} from "json-patch-to-crdt";

const state = createState({ counter: 1 }, { actor: "A" });
const saved = serializeState(state);

const restored = deserializeState(saved);
const next = applyPatch(restored, [{ op: "replace", path: "/counter", value: 2 }]);

console.log(toJson(next));
// { counter: 2 }
```

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

## API Overview

Main exports most apps need:

- `createState(initial, { actor })`
- `forkState(origin, actor)`
- `applyPatch(state, patch, options?)`
- `tryApplyPatch(state, patch, options?)`
- `mergeState(local, remote, { actor })`
- `tryMergeState(local, remote, options?)`
- `toJson(stateOrDoc)`
- `diffJsonPatch(baseJson, nextJson, options?)`
- `serializeState(state)` / `deserializeState(payload)`
- `validateJsonPatch(baseJson, patch, options?)`

Advanced/internal helpers are available from:

```ts
import { crdtToJsonPatch, applyPatchAsActor } from "json-patch-to-crdt/internals";
```

## Notes

- Arrays use a CRDT sequence internally; concurrent inserts are preserved.
- Patches are interpreted relative to a snapshot (RFC-style sequential execution by default).
- Merge assumes replicas come from the same origin state (use `forkState`).

## License

MIT
