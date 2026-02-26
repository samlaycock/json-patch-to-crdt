import type {
  ApplyError,
  ActorId,
  ApplyPatchAsActorResult,
  ApplyPatchAsActorOptions,
  ApplyPatchInPlaceOptions,
  ApplyPatchOptions,
  ApplyResult,
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
  TryApplyPatchInPlaceResult,
  TryApplyPatchResult,
  ValidatePatchResult,
  VersionVector,
} from "./types";

import { createClock, cloneClock } from "./clock";
import { TraversalDepthError, assertTraversalDepth, toDepthApplyError } from "./depth";
import { applyIntentsToCrdt, cloneDoc, docFromJson } from "./doc";
import {
  JsonValueValidationError,
  assertRuntimeJsonValue,
  coerceRuntimeJsonValue,
} from "./json-value";
import { materialize } from "./materialize";
import {
  PatchCompileError,
  compileJsonPatchToIntent,
  getAtJson,
  mapLookupErrorToPatchReason,
  parseJsonPointer,
} from "./patch";

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
  execution: "batch" | "step",
): ApplyResult {
  const semantics: PatchSemantics = options.semantics ?? "sequential";

  if (semantics === "sequential") {
    if (!options.base && execution === "batch") {
      const baseJson = materialize(state.doc.root);
      const compiled = compileIntents(
        baseJson,
        patch,
        "sequential",
        options.jsonValidation ?? "none",
      );
      if (!compiled.ok) {
        return compiled;
      }

      return applyIntentsToCrdt(
        state.doc,
        state.doc,
        compiled.intents,
        () => state.clock.next(),
        options.testAgainst ?? "head",
        (ctr) => bumpClockCounter(state, ctr),
        { strictParents: options.strictParents },
      );
    }

    // When callers pass an explicit base, we keep a private shadow copy that advances
    // per operation so array index and pointer resolution remain consistent with RFC 6902.
    const explicitBaseState: CrdtState | null = options.base
      ? {
          doc: cloneDoc(options.base.doc),
          clock: createClock("__base__", 0),
        }
      : null;
    let sequentialHeadJson = materialize(state.doc.root);
    let sequentialBaseJson = explicitBaseState
      ? materialize(explicitBaseState.doc.root)
      : sequentialHeadJson;

    for (const [opIndex, op] of patch.entries()) {
      const baseDoc = explicitBaseState ? explicitBaseState.doc : state.doc;
      const step = applyPatchOpSequential(
        state,
        op,
        options,
        baseDoc,
        sequentialBaseJson,
        sequentialHeadJson,
        explicitBaseState,
        opIndex,
      );
      if (!step.ok) {
        return step;
      }
      sequentialBaseJson = step.baseJson;
      sequentialHeadJson = step.headJson;
    }

    return { ok: true };
  }

  const baseDoc = options.base ? options.base.doc : cloneDoc(state.doc);
  const baseJson = materialize(baseDoc.root);
  const compiled = compileIntents(baseJson, patch, "base", options.jsonValidation ?? "none");
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

function applyPatchOpSequential(
  state: CrdtState,
  op: JsonPatchOp,
  options: ApplyPatchOptions,
  baseDoc: Doc,
  baseJson: JsonValue,
  headJson: JsonValue,
  explicitBaseState: CrdtState | null,
  opIndex: number,
): ApplyPatchOpSequentialResult {
  if (op.op === "move") {
    const fromResolved = resolveValueAtPointer(baseJson, op.from, opIndex);
    if (!fromResolved.ok) {
      return fromResolved;
    }

    const fromValue = structuredClone(fromResolved.value);
    const removeRes = applySinglePatchOpSequentialStep(
      state,
      baseDoc,
      baseJson,
      headJson,
      { op: "remove", path: op.from },
      options,
      explicitBaseState,
    );
    if (!removeRes.ok) {
      return removeRes;
    }

    // `move` resolves `path` after removal; compile/add against the post-remove shadow.
    const addOp: JsonPatchOp = {
      op: "add",
      path: op.path,
      value: fromValue,
    };
    if (!explicitBaseState) {
      return applySinglePatchOpSequentialStep(
        state,
        state.doc,
        removeRes.baseJson,
        removeRes.headJson,
        addOp,
        options,
        null,
      );
    }

    const headAddRes = applySinglePatchOpSequentialStep(
      state,
      state.doc,
      removeRes.headJson,
      removeRes.headJson,
      addOp,
      options,
      null,
    );
    if (!headAddRes.ok) {
      return headAddRes;
    }

    const shadowAddRes = applySinglePatchOpExplicitShadowStep(
      explicitBaseState,
      removeRes.baseJson,
      addOp,
      options,
    );
    if (!shadowAddRes.ok) {
      return shadowAddRes;
    }

    return {
      ok: true,
      baseJson: shadowAddRes.baseJson,
      headJson: headAddRes.headJson,
    };
  }

  if (op.op === "copy") {
    const fromResolved = resolveValueAtPointer(baseJson, op.from, opIndex);
    if (!fromResolved.ok) {
      return fromResolved;
    }

    return applySinglePatchOpSequentialStep(
      state,
      baseDoc,
      baseJson,
      headJson,
      {
        op: "add",
        path: op.path,
        value: structuredClone(fromResolved.value),
      },
      options,
      explicitBaseState,
    );
  }

  return applySinglePatchOpSequentialStep(
    state,
    baseDoc,
    baseJson,
    headJson,
    op,
    options,
    explicitBaseState,
  );
}

type ApplyPatchOpSequentialResult =
  | { ok: true; baseJson: JsonValue; headJson: JsonValue }
  | ApplyError;

function applySinglePatchOpSequentialStep(
  state: CrdtState,
  baseDoc: Doc,
  baseJson: JsonValue,
  headJson: JsonValue,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  options: ApplyPatchOptions,
  explicitBaseState: CrdtState | null,
): ApplyPatchOpSequentialResult {
  const compiled = compileIntents(baseJson, [op], "sequential", options.jsonValidation ?? "none");
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
    return headStep;
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
      return shadowStep;
    }
  }

  if (op.op === "test") {
    return { ok: true, baseJson, headJson };
  }

  const nextBaseJson = applyJsonPatchOpToShadow(baseJson, op);
  const nextHeadJson = explicitBaseState ? applyJsonPatchOpToShadow(headJson, op) : nextBaseJson;
  return {
    ok: true,
    baseJson: nextBaseJson,
    headJson: nextHeadJson,
  };
}

function applySinglePatchOpExplicitShadowStep(
  explicitBaseState: CrdtState,
  baseJson: JsonValue,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
  options: ApplyPatchOptions,
): { ok: true; baseJson: JsonValue } | ApplyError {
  const compiled = compileIntents(baseJson, [op], "sequential", options.jsonValidation ?? "none");
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
    return shadowStep;
  }

  if (op.op === "test") {
    return { ok: true, baseJson };
  }

  return { ok: true, baseJson: applyJsonPatchOpToShadow(baseJson, op) };
}

function applyJsonPatchOpToShadow(
  baseJson: JsonValue,
  op: Exclude<JsonPatchOp, { op: "move" | "copy" }>,
): JsonValue {
  const path = parseJsonPointer(op.path);

  if (path.length === 0) {
    if (op.op === "test") {
      return baseJson;
    }

    if (op.op === "remove") {
      return null;
    }

    return structuredClone(op.value);
  }

  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1]!;
  const parent = getAtJson(baseJson, parentPath);

  if (Array.isArray(parent)) {
    const idx = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(idx)) {
      throw new Error(`Invalid array index ${key}`);
    }

    if (op.op === "add") {
      parent.splice(idx, 0, structuredClone(op.value));
      return baseJson;
    }

    if (op.op === "remove") {
      parent.splice(idx, 1);
      return baseJson;
    }

    if (op.op === "replace") {
      parent[idx] = structuredClone(op.value);
      return baseJson;
    }

    return baseJson;
  }

  const obj = parent as Record<string, JsonValue>;
  if (op.op === "add" || op.op === "replace") {
    obj[key] = structuredClone(op.value);
    return baseJson;
  }

  if (op.op === "remove") {
    delete obj[key];
    return baseJson;
  }

  return baseJson;
}

function resolveValueAtPointer(
  baseJson: JsonValue,
  pointer: string,
  opIndex: number,
): { ok: true; value: JsonValue } | ApplyError {
  let path: string[];
  try {
    path = parseJsonPointer(pointer);
  } catch (error) {
    return toPointerParseApplyError(error, pointer, opIndex);
  }

  try {
    return {
      ok: true,
      value: getAtJson(baseJson, path),
    };
  } catch (error) {
    return toPointerLookupApplyError(error, pointer, opIndex);
  }
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
  jsonValidation: JsonValidationMode = "none",
): { ok: true; intents: IntentOp[] } | ApplyError {
  try {
    const runtimePatch = preparePatchPayloads(patch, jsonValidation);

    return {
      ok: true,
      intents: compileJsonPatchToIntent(baseJson, runtimePatch, {
        semantics,
      }),
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

function maxCtrInNodeForActor(node: Node, actor: ActorId): number {
  let best = 0;
  const stack: Array<{ node: Node; depth: number }> = [{ node, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.node.kind === "lww") {
      if (frame.node.dot.actor === actor && frame.node.dot.ctr > best) {
        best = frame.node.dot.ctr;
      }
      continue;
    }

    if (frame.node.kind === "obj") {
      for (const entry of frame.node.entries.values()) {
        if (entry.dot.actor === actor && entry.dot.ctr > best) {
          best = entry.dot.ctr;
        }
        stack.push({ node: entry.node, depth: frame.depth + 1 });
      }

      for (const tomb of frame.node.tombstone.values()) {
        if (tomb.actor === actor && tomb.ctr > best) {
          best = tomb.ctr;
        }
      }
      continue;
    }

    for (const elem of frame.node.elems.values()) {
      if (elem.insDot.actor === actor && elem.insDot.ctr > best) {
        best = elem.insDot.ctr;
      }
      stack.push({ node: elem.value, depth: frame.depth + 1 });
    }
  }

  return best;
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

function toPointerLookupApplyError(error: unknown, pointer: string, opIndex: number): ApplyError {
  const mapped = mapLookupErrorToPatchReason(error);

  return {
    ok: false,
    code: 409,
    reason: mapped.reason,
    message: mapped.message,
    path: pointer,
    opIndex,
  };
}
