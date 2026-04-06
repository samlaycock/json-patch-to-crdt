import type {
  ApplyError,
  ActorId,
  ApplyPatchAsActorResult,
  ApplyPatchAsActorOptions,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  ApplyResult,
  CompilePatchOptions,
  CreateStateOptions,
  CrdtState,
  Doc,
  ForkStateOptions,
  IntentOp,
  JsonValidationMode,
  JsonPatchOp,
  JsonValue,
  Node,
  PatchErrorReason,
  PatchSemantics,
  TryApplyPatchAsActorResult,
  TryApplyPatchInPlaceResult,
  TryApplyPatchResult,
  ValidatePatchResult,
  VersionVector,
} from "./types";

import { createClock, cloneClock } from "./clock";
import { TraversalDepthError, toDepthApplyError } from "./depth";
import { applyIntentsToCrdt, cloneDoc, docFromJson } from "./doc";
import {
  JsonValueValidationError,
  assertRuntimeJsonValue,
  coerceRuntimeJsonValue,
} from "./json-value";
import { materialize } from "./materialize";
import {
  ARRAY_INDEX_TOKEN_PATTERN,
  PatchCompileError,
  compileJsonPatchOpToIntent,
  compileJsonPatchToIntent,
  parseJsonPointer,
  stringifyJsonPointer,
} from "./patch";
import { rgaIdAtIndex, rgaLength } from "./rga";
import { ROOT_KEY } from "./types";
import { observedVersionVector } from "./version-vector";

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
export function createState(initial: JsonValue, options: CreateStateOptions): CrdtState {
  const clock = createClock(options.actor, options.start ?? 0);
  const normalizedInitial = coerceRuntimeJsonValue(initial, options.jsonValidation ?? "none");
  const doc = docFromJson(normalizedInitial, clock.next);
  return { doc, clock };
}

/**
 * Fork a replica from a shared origin state while assigning a new local actor ID.
 * The forked state has an independent document clone and clock.
 * By default this rejects actor reuse to prevent duplicate-dot collisions across peers.
 */
export function forkState(
  origin: CrdtState,
  actor: ActorId,
  options: ForkStateOptions = {},
): CrdtState {
  if (actor === origin.clock.actor && !options.allowActorReuse) {
    throw new Error(`forkState actor must be unique; refusing to reuse origin actor '${actor}'`);
  }

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

  try {
    const result = applyPatchInternal(nextState, patch, options, "batch");
    if (!result.ok) {
      return { ok: false, error: result };
    }
  } catch (error) {
    return { ok: false, error: toApplyError(error) };
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

  try {
    const result = applyPatchInternal(state, patch, applyOptions, "step");
    if (!result.ok) {
      return { ok: false, error: result };
    }
  } catch (error) {
    return { ok: false, error: toApplyError(error) };
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
  const state = createState(base, {
    actor: "__validate__",
    jsonValidation: options.jsonValidation,
  });
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
  const result = tryApplyPatchAsActor(doc, vv, actor, patch, options);
  if (!result.ok) {
    throw new PatchError(result.error);
  }

  return { state: result.state, vv: result.vv };
}

/** Non-throwing `applyPatchAsActor` variant for internals sync flows. */
export function tryApplyPatchAsActor(
  doc: Doc,
  vv: VersionVector,
  actor: ActorId,
  patch: JsonPatchOp[],
  options: ApplyPatchAsActorOptions = {},
): TryApplyPatchAsActorResult {
  const observedCtr = observedVersionVector(doc)[actor] ?? 0;
  const start = Math.max(vv[actor] ?? 0, observedCtr);

  const baseState: CrdtState = {
    doc,
    clock: createClock(actor, start),
  };

  const applied = tryApplyPatch(baseState, patch, toApplyPatchOptionsForActor(options));
  if (!applied.ok) {
    return applied;
  }

  const nextVv: VersionVector = {
    ...vv,
    [actor]: Math.max(vv[actor] ?? 0, applied.state.clock.ctr),
  };

  return { ok: true, state: applied.state, vv: nextVv };
}

function toApplyPatchOptionsForActor(options: ApplyPatchAsActorOptions): ApplyPatchOptions {
  return {
    semantics: options.semantics,
    testAgainst: options.testAgainst,
    strictParents: options.strictParents,
    jsonValidation: options.jsonValidation,
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
  _execution: "batch" | "step",
): ApplyResult {
  const jsonValidation = options.jsonValidation ?? "none";
  const preparedPatch = preparePatchPayloadsSafe(patch, jsonValidation);
  if (!preparedPatch.ok) {
    return preparedPatch;
  }

  const runtimePatch = preparedPatch.patch;
  const semantics: PatchSemantics = options.semantics ?? "sequential";

  if (semantics === "sequential") {
    // When callers pass an explicit base, we keep a private shadow copy that advances
    // per operation so array index and pointer resolution remain consistent with RFC 6902.
    const explicitBaseState: CrdtState | null = options.base
      ? {
          doc: cloneDoc(options.base.doc),
          clock: createClock("__base__", 0),
        }
      : null;
    const session: SequentialApplySession = {
      pointerCache: new Map(),
    };

    for (const [opIndex, op] of runtimePatch.entries()) {
      const baseDoc = explicitBaseState ? explicitBaseState.doc : state.doc;
      const step = applyPatchOpSequential(
        state,
        op,
        options,
        baseDoc,
        explicitBaseState,
        opIndex,
        session,
      );
      if (!step.ok) {
        return step;
      }
    }

    return { ok: true };
  }

  const baseDoc = options.base ? options.base.doc : cloneDoc(state.doc);
  const baseJson = materialize(baseDoc.root);
  const compiled = compilePreparedIntents(baseJson, runtimePatch, "base");
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
    { strictParents: options.strictParents },
  );
}

type SequentialApplySession = {
  pointerCache: Map<string, string[]>;
};

function applyPatchOpSequential(
  state: CrdtState,
  op: JsonPatchOp,
  options: ApplyPatchOptions,
  baseDoc: Doc,
  explicitBaseState: CrdtState | null,
  opIndex: number,
  session: SequentialApplySession,
): ApplyResult {
  if (op.op === "move") {
    const fromResolved = resolveValueAtPointerInDoc(
      baseDoc,
      op.from,
      opIndex,
      session.pointerCache,
    );
    if (!fromResolved.ok) {
      return fromResolved;
    }

    const fromValue = structuredClone(fromResolved.value);
    const removeRes = applySinglePatchOpSequentialStep(
      state,
      baseDoc,
      { op: "remove", path: op.from },
      options,
      explicitBaseState,
      opIndex,
      session,
    );
    if (!removeRes.ok) {
      return removeRes;
    }

    // `move` resolves `path` after removal; compile/add against the post-remove doc state.
    const addOp: JsonPatchOp = {
      op: "add",
      path: op.path,
      value: fromValue,
    };
    if (!explicitBaseState) {
      return applySinglePatchOpSequentialStep(
        state,
        state.doc,
        addOp,
        options,
        null,
        opIndex,
        session,
      );
    }

    const headAddRes = applySinglePatchOpSequentialStep(
      state,
      state.doc,
      addOp,
      options,
      null,
      opIndex,
      session,
    );
    if (!headAddRes.ok) {
      return headAddRes;
    }

    const shadowAddRes = applySinglePatchOpExplicitShadowStep(
      explicitBaseState,
      addOp,
      options,
      opIndex,
      session,
    );
    if (!shadowAddRes.ok) {
      return shadowAddRes;
    }

    return { ok: true };
  }

  if (op.op === "copy") {
    const fromResolved = resolveValueAtPointerInDoc(
      baseDoc,
      op.from,
      opIndex,
      session.pointerCache,
    );
    if (!fromResolved.ok) {
      return fromResolved;
    }

    return applySinglePatchOpSequentialStep(
      state,
      baseDoc,
      {
        op: "add",
        path: op.path,
        value: structuredClone(fromResolved.value),
      },
      options,
      explicitBaseState,
      opIndex,
      session,
    );
  }

  return applySinglePatchOpSequentialStep(
    state,
    baseDoc,
    op,
    options,
    explicitBaseState,
    opIndex,
    session,
  );
}

function applySinglePatchOpSequentialStep(
  state: CrdtState,
  baseDoc: Doc,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  options: ApplyPatchOptions,
  explicitBaseState: CrdtState | null,
  opIndex: number,
  session: SequentialApplySession,
): ApplyResult {
  const compiled = compilePreparedSingleIntentFromDoc(baseDoc, op, session.pointerCache, opIndex);
  if (!compiled.ok) {
    return compiled;
  }

  const headStep = applyIntentsToCrdt(
    baseDoc,
    state.doc,
    compiled.intents,
    () => state.clock.next(),
    options.testAgainst ?? "head",
    (ctr) => bumpClockCounter(state, ctr),
    { strictParents: options.strictParents },
  );
  if (!headStep.ok) {
    return withOpIndex(headStep, opIndex);
  }

  if (explicitBaseState && op.op !== "test") {
    const shadowStep = applyIntentsToCrdt(
      explicitBaseState.doc,
      explicitBaseState.doc,
      compiled.intents,
      () => explicitBaseState.clock.next(),
      "base",
      (ctr) => bumpClockCounter(explicitBaseState, ctr),
      { strictParents: options.strictParents },
    );
    if (!shadowStep.ok) {
      return withOpIndex(shadowStep, opIndex);
    }
  }

  return { ok: true };
}

function applySinglePatchOpExplicitShadowStep(
  explicitBaseState: CrdtState,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  options: ApplyPatchOptions,
  opIndex: number,
  session: SequentialApplySession,
): ApplyResult {
  const compiled = compilePreparedSingleIntentFromDoc(
    explicitBaseState.doc,
    op,
    session.pointerCache,
    opIndex,
  );
  if (!compiled.ok) {
    return compiled;
  }

  const shadowStep = applyIntentsToCrdt(
    explicitBaseState.doc,
    explicitBaseState.doc,
    compiled.intents,
    () => explicitBaseState.clock.next(),
    "base",
    (ctr) => bumpClockCounter(explicitBaseState, ctr),
    { strictParents: options.strictParents },
  );
  if (!shadowStep.ok) {
    return withOpIndex(shadowStep, opIndex);
  }

  return { ok: true };
}

function resolveValueAtPointerInDoc(
  doc: Doc,
  pointer: string,
  opIndex: number,
  pointerCache: Map<string, string[]>,
): { ok: true; value: JsonValue } | ApplyError {
  let path: string[];
  try {
    path = parsePointerWithCache(pointer, pointerCache);
  } catch (error) {
    return toPointerParseApplyError(error, pointer, opIndex);
  }

  const resolved = resolveNodeAtPath(doc.root, path);
  if (!resolved.ok) {
    return {
      ok: false,
      ...resolved.error,
      path: pointer,
      opIndex,
    };
  }

  return {
    ok: true,
    value: materialize(resolved.node),
  };
}

function compilePreparedSingleIntentFromDoc(
  baseDoc: Doc,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  pointerCache: Map<string, string[]>,
  opIndex: number,
): { ok: true; intents: IntentOp[] } | ApplyError {
  let path: string[];
  try {
    path = parsePointerWithCache(op.path, pointerCache);
  } catch (error) {
    return toPointerParseApplyError(error, op.path, opIndex);
  }

  if (op.op === "test") {
    return {
      ok: true,
      intents: [{ t: "Test", path, value: op.value }],
    };
  }

  if (path.length === 0) {
    if (op.op === "remove") {
      return {
        ok: false,
        code: 409,
        reason: "INVALID_TARGET",
        message: "remove at root path is not supported in RFC-compliant mode",
        path: op.path,
        opIndex,
      };
    }

    return {
      ok: true,
      intents: [{ t: "ObjSet", path: [], key: ROOT_KEY, value: op.value }],
    };
  }

  const parentPath = path.slice(0, -1);
  const parentPointer = stringifyJsonPointer(parentPath);
  const key = path[path.length - 1]!;
  const resolvedParent =
    parentPath.length === 0
      ? { ok: true as const, node: baseDoc.root }
      : resolveNodeAtPath(baseDoc.root, parentPath);
  if (!resolvedParent.ok) {
    return {
      ok: false,
      ...resolvedParent.error,
      path: parentPointer,
      opIndex,
    };
  }

  const parentNode = resolvedParent.node;
  if (parentNode.kind === "seq") {
    const parsedIndex = parseArrayIndexTokenForDoc(key, op.op, op.path, opIndex);
    if (!parsedIndex.ok) {
      return parsedIndex;
    }

    const boundedIndex = validateArrayIndexBounds(
      parsedIndex.index,
      op.op,
      rgaLength(parentNode),
      op.path,
      opIndex,
    );
    if (!boundedIndex.ok) {
      return boundedIndex;
    }

    if (op.op === "add") {
      return {
        ok: true,
        intents: [{ t: "ArrInsert", path: parentPath, index: boundedIndex.index, value: op.value }],
      };
    }

    if (op.op === "remove") {
      return {
        ok: true,
        intents: [{ t: "ArrDelete", path: parentPath, index: boundedIndex.index }],
      };
    }

    return {
      ok: true,
      intents: [{ t: "ArrReplace", path: parentPath, index: boundedIndex.index, value: op.value }],
    };
  }

  if (parentNode.kind !== "obj") {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_TARGET",
      message: `expected object or array parent at ${parentPointer}`,
      path: parentPointer,
      opIndex,
    };
  }

  if (key === "__proto__") {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_POINTER",
      message: `unsafe object key at ${op.path}`,
      path: op.path,
      opIndex,
    };
  }

  const entry = parentNode.entries.get(key);
  if ((op.op === "replace" || op.op === "remove") && !entry) {
    return {
      ok: false,
      code: 409,
      reason: "MISSING_TARGET",
      message: `missing key ${key} at ${parentPointer}`,
      path: op.path,
      opIndex,
    };
  }

  if (op.op === "remove") {
    return {
      ok: true,
      intents: [{ t: "ObjRemove", path: parentPath, key }],
    };
  }

  return {
    ok: true,
    intents: [
      {
        t: "ObjSet",
        path: parentPath,
        key,
        value: op.value,
        mode: op.op,
      },
    ],
  };
}

function parsePointerWithCache(pointer: string, pointerCache: Map<string, string[]>): string[] {
  const cachedPath = pointerCache.get(pointer);
  if (cachedPath !== undefined) {
    // Return a copy so downstream callers cannot mutate cached pointer segments.
    return cachedPath.slice();
  }

  const parsedPath = parseJsonPointer(pointer);
  pointerCache.set(pointer, parsedPath);
  return parsedPath.slice();
}

function resolveNodeAtPath(
  root: Node,
  path: string[],
):
  | { ok: true; node: Node }
  | { ok: false; error: Omit<ApplyError, "ok" | "code"> & { code: 409 } } {
  let current = root;

  for (const segment of path) {
    if (current.kind === "obj") {
      const entry = current.entries.get(segment);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "MISSING_PARENT",
            message: `Missing key '${segment}'`,
          },
        };
      }

      current = entry.node;
      continue;
    }

    if (current.kind === "seq") {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(segment)) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "INVALID_POINTER",
            message: `Expected array index, got '${segment}'`,
          },
        };
      }

      const index = Number(segment);
      if (!Number.isSafeInteger(index)) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${segment}'`,
          },
        };
      }

      const elemId = rgaIdAtIndex(current, index);
      if (elemId === undefined) {
        return {
          ok: false,
          error: {
            code: 409,
            reason: "OUT_OF_BOUNDS",
            message: `Index out of bounds at '${segment}'`,
          },
        };
      }

      current = current.elems.get(elemId)!.value;
      continue;
    }

    return {
      ok: false,
      error: {
        code: 409,
        reason: "INVALID_TARGET",
        message: `Cannot traverse into non-container at '${segment}'`,
      },
    };
  }

  return { ok: true, node: current };
}

function parseArrayIndexTokenForDoc(
  token: string,
  op: "add" | "remove" | "replace",
  path: string,
  opIndex: number,
): { ok: true; index: number } | ApplyError {
  if (token === "-") {
    if (op !== "add") {
      return {
        ok: false,
        code: 409,
        reason: "INVALID_POINTER",
        message: `'-' index is only valid for add at ${path}`,
        path,
        opIndex,
      };
    }

    return { ok: true, index: Number.POSITIVE_INFINITY };
  }

  if (!ARRAY_INDEX_TOKEN_PATTERN.test(token)) {
    return {
      ok: false,
      code: 409,
      reason: "INVALID_POINTER",
      message: `expected array index at ${path}`,
      path,
      opIndex,
    };
  }

  const index = Number(token);
  if (!Number.isSafeInteger(index)) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `array index is too large at ${path}`,
      path,
      opIndex,
    };
  }

  return { ok: true, index };
}

function validateArrayIndexBounds(
  index: number,
  op: "add" | "remove" | "replace",
  arrLength: number,
  path: string,
  opIndex: number,
): { ok: true; index: number } | ApplyError {
  if (op === "add") {
    if (index === Number.POSITIVE_INFINITY) {
      return { ok: true, index };
    }

    if (index > arrLength) {
      return {
        ok: false,
        code: 409,
        reason: "OUT_OF_BOUNDS",
        message: `index out of bounds at ${path}; expected 0..${arrLength}`,
        path,
        opIndex,
      };
    }
  } else if (index >= arrLength) {
    return {
      ok: false,
      code: 409,
      reason: "OUT_OF_BOUNDS",
      message: `index out of bounds at ${path}; expected 0..${Math.max(arrLength - 1, 0)}`,
      path,
      opIndex,
    };
  }

  return { ok: true, index };
}

function bumpClockCounter(state: CrdtState, ctr: number): void {
  if (state.clock.ctr < ctr) {
    state.clock.ctr = ctr;
  }
}

function compilePreparedIntents(
  baseJson: JsonValue,
  patch: JsonPatchOp[],
  semantics: PatchSemantics = "sequential",
  pointerCache?: Map<string, string[]>,
  opIndexOffset = 0,
): { ok: true; intents: IntentOp[] } | ApplyError {
  try {
    const compileOptions = toCompilePatchOptions(semantics, pointerCache, opIndexOffset);
    if (patch.length === 1) {
      return {
        ok: true,
        intents: compileJsonPatchOpToIntent(baseJson, patch[0]!, compileOptions),
      };
    }

    return {
      ok: true,
      intents: compileJsonPatchToIntent(baseJson, patch, compileOptions),
    };
  } catch (error) {
    return toApplyError(error);
  }
}

function toCompilePatchOptions(
  semantics: PatchSemantics,
  pointerCache?: Map<string, string[]>,
  opIndexOffset = 0,
): CompilePatchOptions {
  // Internal session hints are consumed in patch.ts but are not part of the public type.
  return {
    semantics,
    pointerCache,
    opIndexOffset,
  } as CompilePatchOptions;
}

function preparePatchPayloadsSafe(
  patch: JsonPatchOp[],
  mode: JsonValidationMode,
): { ok: true; patch: JsonPatchOp[] } | ApplyError {
  try {
    return {
      ok: true,
      patch: preparePatchPayloads(patch, mode),
    };
  } catch (error) {
    return toApplyError(error);
  }
}

function preparePatchPayloads(patch: JsonPatchOp[], mode: JsonValidationMode): JsonPatchOp[] {
  if (mode === "none") {
    return patch;
  }

  const out: JsonPatchOp[] = [];

  for (const [opIndex, op] of patch.entries()) {
    if (op.op === "move" || op.op === "copy" || op.op === "remove") {
      out.push(op);
      continue;
    }

    if (mode === "strict") {
      try {
        assertRuntimeJsonValue(op.value);
      } catch (error) {
        if (error instanceof JsonValueValidationError) {
          throw patchPayloadCompileError(op, opIndex, error);
        }

        throw error;
      }

      out.push(op);
      continue;
    }

    out.push({
      ...op,
      value: coerceRuntimeJsonValue(op.value, mode),
    });
  }

  return out;
}

function patchPayloadCompileError(
  op: Extract<JsonPatchOp, { value: JsonValue }>,
  opIndex: number,
  error: JsonValueValidationError,
): PatchCompileError {
  const path = mergePointerPaths(op.path, error.path);
  return new PatchCompileError(
    "INVALID_PATCH",
    `invalid JSON value for '${op.op}' at ${path === "" ? "<root>" : path}: ${error.detail}`,
    path,
    opIndex,
  );
}

function mergePointerPaths(basePointer: string, nestedPointer: string): string {
  if (nestedPointer === "") {
    return basePointer;
  }

  if (basePointer === "") {
    return nestedPointer;
  }

  return `${basePointer}${nestedPointer}`;
}

function toApplyError(error: unknown): ApplyError {
  if (error instanceof TraversalDepthError) {
    return toDepthApplyError(error);
  }

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

function withOpIndex(error: ApplyError, opIndex: number): ApplyError {
  if (error.opIndex !== undefined) {
    return error;
  }

  return { ...error, opIndex };
}

function toPointerParseApplyError(error: unknown, pointer: string, opIndex: number): ApplyError {
  return {
    ok: false,
    code: 409,
    reason: "INVALID_POINTER",
    message: error instanceof Error ? error.message : "invalid pointer",
    path: pointer,
    opIndex,
  };
}
