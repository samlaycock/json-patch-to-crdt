import { createClock, cloneClock } from "./clock";
import { applyIntentsToCrdt, cloneDoc, docFromJson } from "./doc";
import { materialize } from "./materialize";
import { compileJsonPatchToIntent, getAtJson, parseJsonPointer } from "./patch";
import type {
  ActorId,
  ApplyPatchAsActorResult,
  ApplyPatchOptions,
  ApplyResult,
  CrdtState,
  Doc,
  IntentOp,
  JsonPatchOp,
  JsonValue,
  Node,
  PatchSemantics,
  VersionVector,
} from "./types";

/** Error thrown when a JSON Patch cannot be applied. Includes a numeric `.code` (409 for conflicts). */
export class PatchError extends Error {
  readonly code: number;

  constructor(message: string, code = 409) {
    super(message);
    this.name = "PatchError";
    this.code = code;
  }
}

/**
 * Create a new CRDT state from an initial JSON value.
 * @param initial - The initial JSON document.
 * @param options - Actor ID and optional starting counter.
 * @returns A new `CrdtState` containing the document and clock.
 */
export function createState(
  initial: JsonValue,
  options: { actor: ActorId; start?: number },
): CrdtState {
  const clock = createClock(options.actor, options.start ?? 0);
  const doc = docFromJson(initial, clock.next);
  return { doc, clock };
}

/**
 * Materialize a CRDT document or state back to a plain JSON value.
 * @param target - A `Doc` or `CrdtState` to materialize.
 * @returns The JSON representation of the current document.
 */
export function toJson(target: Doc | CrdtState): JsonValue {
  if ("doc" in target) {
    return materialize(target.doc.root);
  }

  return materialize(target.root);
}

/**
 * Apply a JSON Patch to the state, returning a new immutable state.
 * Throws `PatchError` on conflict (e.g. out-of-bounds index, failed test op).
 * @param state - The current CRDT state.
 * @param patch - Array of RFC 6902 JSON Patch operations.
 * @param options - Optional base document and test evaluation mode.
 * @returns A new `CrdtState` with the patch applied.
 */
export function applyPatch(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): CrdtState {
  const nextState: CrdtState = {
    doc: cloneDoc(state.doc),
    clock: cloneClock(state.clock),
  };

  const result = applyPatchInternal(nextState, patch, options);

  if (!result.ok) {
    throw new PatchError(result.message, result.code);
  }

  return nextState;
}

/**
 * Apply a JSON Patch to the state in place, mutating the existing state.
 * Throws `PatchError` on conflict.
 * @param state - The CRDT state to mutate.
 * @param patch - Array of RFC 6902 JSON Patch operations.
 * @param options - Optional base document and test evaluation mode.
 */
export function applyPatchInPlace(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): void {
  if (options.atomic ?? true) {
    const next = applyPatch(state, patch, options);
    state.doc = next.doc;
    state.clock = next.clock;
    return;
  }

  const result = applyPatchInternal(state, patch, options);

  if (!result.ok) {
    throw new PatchError(result.message, result.code);
  }
}

/**
 * Apply a JSON Patch as a specific actor while maintaining an external version vector.
 * Returns the updated state and a new version vector snapshot.
 */
export function applyPatchAsActor(
  doc: Doc,
  vv: VersionVector,
  actor: ActorId,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): ApplyPatchAsActorResult {
  const observedCtr = maxCtrInNodeForActor(doc.root, actor);
  const start = Math.max(vv[actor] ?? 0, observedCtr);

  const baseState: CrdtState = {
    doc,
    clock: createClock(actor, start),
  };

  const state = applyPatch(baseState, patch, options);
  const nextVv: VersionVector = {
    ...vv,
    [actor]: Math.max(vv[actor] ?? 0, state.clock.ctr),
  };

  return { state, vv: nextVv };
}

function applyPatchInternal(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions,
): ApplyResult {
  const semantics: PatchSemantics = options.semantics ?? "base";

  if (semantics === "sequential") {
    const explicitBaseState: CrdtState | null = options.base
      ? {
          doc: cloneDoc(options.base),
          clock: createClock("__base__", 0),
        }
      : null;

    for (const op of patch) {
      const baseDoc = explicitBaseState ? explicitBaseState.doc : cloneDoc(state.doc);
      const step = applyPatchOpSequential(state, op, options, baseDoc);
      if (!step.ok) {
        return step;
      }

      if (explicitBaseState) {
        const baseStep = applyPatchInternal(explicitBaseState, [op], {
          semantics: "sequential",
          testAgainst: options.testAgainst,
        });
        if (!baseStep.ok) {
          return baseStep;
        }
      }
    }

    return { ok: true };
  }

  const baseDoc = options.base ? options.base : cloneDoc(state.doc);
  const baseJson = materialize(baseDoc.root);
  const compiled = compileIntents(baseJson, patch);
  if (!compiled.ok) {
    return compiled;
  }

  return applyIntentsToCrdt(
    baseDoc,
    state.doc,
    compiled.intents,
    () => state.clock.next(),
    options.testAgainst ?? "head",
    (ctr) => bumpClockCounter(state, ctr),
  );
}

function applyPatchOpSequential(
  state: CrdtState,
  op: JsonPatchOp,
  options: ApplyPatchOptions,
  baseDoc: Doc,
): ApplyResult {
  const baseJson = materialize(baseDoc.root);

  if (op.op === "move") {
    const fromValue = getAtJson(baseJson, parseJsonPointer(op.from));
    const removeRes = applySinglePatchOp(
      state,
      baseDoc,
      {
        op: "remove",
        path: op.from,
      },
      options,
    );
    if (!removeRes.ok) {
      return removeRes;
    }

    const addBase = cloneDoc(state.doc);
    return applySinglePatchOp(
      state,
      addBase,
      {
        op: "add",
        path: op.path,
        value: fromValue,
      },
      options,
    );
  }

  if (op.op === "copy") {
    const fromValue = getAtJson(baseJson, parseJsonPointer(op.from));
    return applySinglePatchOp(
      state,
      baseDoc,
      {
        op: "add",
        path: op.path,
        value: fromValue,
      },
      options,
    );
  }

  return applySinglePatchOp(state, baseDoc, op, options);
}

function applySinglePatchOp(
  state: CrdtState,
  baseDoc: Doc,
  op: JsonPatchOp,
  options: ApplyPatchOptions,
): ApplyResult {
  const baseJson = materialize(baseDoc.root);
  const compiled = compileIntents(baseJson, [op]);
  if (!compiled.ok) {
    return compiled;
  }

  return applyIntentsToCrdt(
    baseDoc,
    state.doc,
    compiled.intents,
    () => state.clock.next(),
    options.testAgainst ?? "head",
    (ctr) => bumpClockCounter(state, ctr),
  );
}

function bumpClockCounter(state: CrdtState, ctr: number): void {
  if (state.clock.ctr < ctr) {
    state.clock.ctr = ctr;
  }
}

function compileIntents(
  baseJson: JsonValue,
  patch: JsonPatchOp[],
): { ok: true; intents: IntentOp[] } | { ok: false; code: 409; message: string } {
  try {
    return { ok: true, intents: compileJsonPatchToIntent(baseJson, patch) };
  } catch (error) {
    return {
      ok: false,
      code: 409,
      message: error instanceof Error ? error.message : "failed to compile patch",
    };
  }
}

function maxCtrInNodeForActor(node: Node, actor: ActorId): number {
  switch (node.kind) {
    case "lww":
      return node.dot.actor === actor ? node.dot.ctr : 0;
    case "obj": {
      let best = 0;
      for (const entry of node.entries.values()) {
        if (entry.dot.actor === actor && entry.dot.ctr > best) {
          best = entry.dot.ctr;
        }

        const childBest = maxCtrInNodeForActor(entry.node, actor);
        if (childBest > best) {
          best = childBest;
        }
      }

      for (const tomb of node.tombstone.values()) {
        if (tomb.actor === actor && tomb.ctr > best) {
          best = tomb.ctr;
        }
      }

      return best;
    }
    case "seq": {
      let best = 0;
      for (const elem of node.elems.values()) {
        if (elem.insDot.actor === actor && elem.insDot.ctr > best) {
          best = elem.insDot.ctr;
        }

        const childBest = maxCtrInNodeForActor(elem.value, actor);
        if (childBest > best) {
          best = childBest;
        }
      }

      return best;
    }
  }
}
