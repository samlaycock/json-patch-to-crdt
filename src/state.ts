import { createClock, cloneClock } from "./clock";
import { applyIntentsToCrdt, cloneDoc, docFromJson } from "./doc";
import { materialize } from "./materialize";
import { PatchCompileError, compileJsonPatchToIntent, getAtJson, parseJsonPointer } from "./patch";
import type {
  ApplyError,
  ActorId,
  ApplyPatchAsActorResult,
  ApplyPatchAsActorOptions,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  ApplyResult,
  CrdtState,
  Doc,
  IntentOp,
  JsonPatchOp,
  JsonValue,
  Node,
  PatchErrorReason,
  PatchSemantics,
  TryApplyPatchInPlaceResult,
  TryApplyPatchResult,
  ValidatePatchResult,
  VersionVector,
} from "./types";

/** Error thrown when a JSON Patch cannot be applied. Includes structured conflict metadata. */
export class PatchError extends Error {
  readonly code: 409;
  readonly reason: PatchErrorReason;
  readonly path?: string;
  readonly opIndex?: number;

  constructor(error: ApplyError);
  constructor(message: string, code?: 409, reason?: PatchErrorReason);
  constructor(
    errorOrMessage: ApplyError | string,
    code: 409 = 409,
    reason: PatchErrorReason = "INVALID_PATCH",
  ) {
    super(typeof errorOrMessage === "string" ? errorOrMessage : errorOrMessage.message);
    this.name = "PatchError";
    if (typeof errorOrMessage === "string") {
      this.code = code;
      this.reason = reason;
      return;
    }

    this.code = errorOrMessage.code;
    this.reason = errorOrMessage.reason;
    this.path = errorOrMessage.path;
    this.opIndex = errorOrMessage.opIndex;
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
 * Fork a replica from a shared origin state while assigning a new local actor ID.
 * The forked state has an independent document clone and clock.
 */
export function forkState(origin: CrdtState, actor: ActorId): CrdtState {
  return {
    doc: cloneDoc(origin.doc),
    clock: createClock(actor, origin.clock.ctr),
  };
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
 * @param options - Optional base state snapshot and patch semantics.
 * @returns A new `CrdtState` with the patch applied.
 */
export function applyPatch(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): CrdtState {
  const result = tryApplyPatch(state, patch, options);
  if (!result.ok) {
    throw new PatchError(result.error);
  }

  return result.state;
}

/**
 * Apply a JSON Patch to the state in place, mutating the existing state.
 * Throws `PatchError` on conflict.
 * @param state - The CRDT state to mutate.
 * @param patch - Array of RFC 6902 JSON Patch operations.
 * @param options - Optional base state snapshot, patch semantics, and atomicity.
 */
export function applyPatchInPlace(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchInPlaceOptions = {},
): void {
  const result = tryApplyPatchInPlace(state, patch, options);
  if (!result.ok) {
    throw new PatchError(result.error);
  }
}

/** Non-throwing immutable patch application variant. */
export function tryApplyPatch(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): TryApplyPatchResult {
  const nextState: CrdtState = {
    doc: cloneDoc(state.doc),
    clock: cloneClock(state.clock),
  };

  const result = applyPatchInternal(nextState, patch, options);
  if (!result.ok) {
    return { ok: false, error: result };
  }

  return { ok: true, state: nextState };
}

/** Non-throwing in-place patch application variant. */
export function tryApplyPatchInPlace(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchInPlaceOptions = {},
): TryApplyPatchInPlaceResult {
  const { atomic = true, ...applyOptions } = options;

  if (atomic) {
    const next = tryApplyPatch(state, patch, applyOptions);
    if (!next.ok) {
      return next;
    }

    state.doc = next.state.doc;
    state.clock = next.state.clock;
    return { ok: true };
  }

  const result = applyPatchInternal(state, patch, applyOptions);
  if (!result.ok) {
    return { ok: false, error: result };
  }

  return { ok: true };
}

/**
 * Validate whether a patch is applicable against a JSON base value under the chosen options.
 * Does not mutate caller-provided values.
 */
export function validateJsonPatch(
  base: JsonValue,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions = {},
): ValidatePatchResult {
  const state = createState(base, { actor: "__validate__" });
  const result = tryApplyPatch(state, patch, options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true };
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
  options: ApplyPatchAsActorOptions = {},
): ApplyPatchAsActorResult {
  const observedCtr = maxCtrInNodeForActor(doc.root, actor);
  const start = Math.max(vv[actor] ?? 0, observedCtr);

  const baseState: CrdtState = {
    doc,
    clock: createClock(actor, start),
  };

  const state = applyPatch(baseState, patch, toApplyPatchOptionsForActor(options));
  const nextVv: VersionVector = {
    ...vv,
    [actor]: Math.max(vv[actor] ?? 0, state.clock.ctr),
  };

  return { state, vv: nextVv };
}

function toApplyPatchOptionsForActor(options: ApplyPatchAsActorOptions): ApplyPatchOptions {
  return {
    semantics: options.semantics,
    testAgainst: options.testAgainst,
    base: options.base
      ? {
          doc: options.base,
          clock: createClock("__base__", 0),
        }
      : undefined,
  };
}

function applyPatchInternal(
  state: CrdtState,
  patch: JsonPatchOp[],
  options: ApplyPatchOptions,
): ApplyResult {
  const semantics: PatchSemantics = options.semantics ?? "sequential";

  if (semantics === "sequential") {
    const explicitBaseState: CrdtState | null = options.base
      ? {
          doc: cloneDoc(options.base.doc),
          clock: createClock("__base__", 0),
        }
      : null;

    for (const op of patch) {
      const baseDoc = explicitBaseState ? explicitBaseState.doc : cloneDoc(state.doc);
      const step = applyPatchOpSequential(state, op, options, baseDoc);
      if (!step.ok) {
        return step;
      }

      if (explicitBaseState && op.op !== "test") {
        const baseStep = applyPatchInternal(explicitBaseState, [op], {
          semantics: "sequential",
          testAgainst: "base",
        });
        if (!baseStep.ok) {
          return baseStep;
        }
      }
    }

    return { ok: true };
  }

  const baseDoc = options.base ? options.base.doc : cloneDoc(state.doc);
  const baseJson = materialize(baseDoc.root);
  const compiled = compileIntents(baseJson, patch, "base");
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
  const compiled = compileIntents(baseJson, [op], "sequential");
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
  semantics: PatchSemantics = "sequential",
): { ok: true; intents: IntentOp[] } | ApplyError {
  try {
    return {
      ok: true,
      intents: compileJsonPatchToIntent(baseJson, patch, {
        semantics,
      }),
    };
  } catch (error) {
    return toApplyError(error);
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

function toApplyError(error: unknown): ApplyError {
  if (error instanceof PatchCompileError) {
    return {
      ok: false,
      code: 409,
      reason: error.reason,
      message: error.message,
      path: error.path,
      opIndex: error.opIndex,
    };
  }

  return {
    ok: false,
    code: 409,
    reason: "INVALID_PATCH",
    message: error instanceof Error ? error.message : "failed to compile patch",
  };
}
