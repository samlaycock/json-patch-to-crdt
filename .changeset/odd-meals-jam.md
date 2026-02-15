---
"json-patch-to-crdt": patch
---

Harden `forkState` against unsafe same-actor replica forking.

- Reject `forkState(origin, actor)` by default when `actor` matches `origin.clock.actor`.
- Add an explicit `allowActorReuse` opt-in for advanced workflows that intentionally reuse actor IDs.
- Document actor uniqueness requirements and add regression tests for default rejection and explicit override behavior.
