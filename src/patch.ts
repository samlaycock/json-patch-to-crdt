import type {
  CompilePatchOptions,
  DiffOptions,
  IntentOp,
  JsonPatchOp,
  JsonValue,
  PatchErrorReason,
} from "./types";

import { assertTraversalDepth } from "./depth";
import { coerceRuntimeJsonValue } from "./json-value";
import { ROOT_KEY } from "./types";

const DEFAULT_LCS_MAX_CELLS = 250_000;
const LINEAR_LCS_MATRIX_BASE_CASE_MAX_CELLS = 4_096;

type ArrayDiffStep = { kind: "add"; value: JsonValue } | { kind: "equal" } | { kind: "remove" };

type TrimmedArrayWindow = {
  baseStart: number;
  nextStart: number;
  prefixLength: number;
  unmatchedBaseLength: number;
  unmatchedNextLength: number;
};

type InternalCompilePatchOptions = {
  pointerCache?: Map<string, string[]>;
  opIndexOffset?: number;
};

interface DiffValueFrame {
  readonly kind: "value";
  readonly base: JsonValue;
  readonly next: JsonValue;
}

interface DiffObjectFrame {
  readonly kind: "object";
  readonly base: Record<string, JsonValue>;
  readonly next: Record<string, JsonValue>;
  readonly sharedKeys: readonly string[];
  readonly index: number;
}

interface DiffPathPopFrame {
  readonly kind: "path-pop";
}

type DiffFrame = DiffValueFrame | DiffObjectFrame | DiffPathPopFrame;

interface JsonEqualFrame {
  readonly left: JsonValue;
  readonly right: JsonValue;
  readonly depth: number;
}

interface StableJsonValueFrame {
  readonly kind: "value";
  readonly value: JsonValue;
  readonly depth: number;
}

interface StableJsonArrayFrame {
  readonly kind: "array";
  readonly value: readonly JsonValue[];
  readonly startIndex: number;
}

interface StableJsonObjectFrame {
  readonly kind: "object";
  readonly value: Record<string, JsonValue>;
  readonly keys: readonly string[];
  readonly startIndex: number;
}

type StableJsonKeyFrame = StableJsonValueFrame | StableJsonArrayFrame | StableJsonObjectFrame;

interface ObjectKeyGroups {
  readonly sharedKeys: string[];
  readonly baseOnlyKeys: string[];
  readonly nextOnlyKeys: string[];
}

/** Structured compile error used to map patch validation failures to typed reasons. */
export class PatchCompileError extends Error {
  readonly reason: PatchErrorReason;
  readonly path?: string;
  readonly opIndex?: number;

  constructor(reason: PatchErrorReason, message: string, path?: string, opIndex?: number) {
    super(message);
    this.name = "PatchCompileError";
    this.reason = reason;
    this.path = path;
    this.opIndex = opIndex;
  }
}

export type JsonLookupErrorCode =
  | "EXPECTED_ARRAY_INDEX"
  | "INDEX_OUT_OF_BOUNDS"
  | "MISSING_KEY"
  | "NON_CONTAINER";

/** Structured lookup error thrown by `getAtJson`. */
export class JsonLookupError extends Error {
  readonly code: JsonLookupErrorCode;
  readonly segment: string;

  constructor(code: JsonLookupErrorCode, segment: string, message: string) {
    super(message);
    this.name = "JsonLookupError";
    this.code = code;
    this.segment = segment;
  }
}

/**
 * Parse an RFC 6901 JSON Pointer into a path array, unescaping `~1` and `~0`.
 * @param ptr - A JSON Pointer string (e.g. `"/a/b"` or `""`).
 * @returns An array of path segments.
 */
export function parseJsonPointer(ptr: string): string[] {
  if (ptr === "") {
    return [];
  }

  if (!ptr.startsWith("/")) {
    throw new Error(`Invalid pointer: ${ptr}`);
  }

  return ptr.slice(1).split("/").map(unescapeJsonPointerToken);
}

/** Convert a path array back to an RFC 6901 JSON Pointer string. */
export function stringifyJsonPointer(path: string[]): string {
  if (path.length === 0) {
    return "";
  }

  return `/${path.map(escapeJsonPointer).join("/")}`;
}

function unescapeJsonPointerToken(token: string): string {
  let out = "";

  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;

    if (ch !== "~") {
      out += ch;
      continue;
    }

    const esc = token[i + 1];
    if (esc === "0") {
      out += "~";
      i += 1;
      continue;
    }

    if (esc === "1") {
      out += "/";
      i += 1;
      continue;
    }

    const sequence = esc === undefined ? "~" : `~${esc}`;
    throw new Error(`Invalid pointer escape sequence '${sequence}'`);
  }

  return out;
}

/**
 * Navigate a JSON value by path and return the value at that location.
 * Throws if the path is invalid, out of bounds, or traverses a non-container.
 */
export function getAtJson(base: JsonValue, path: string[]): JsonValue {
  let cur: any = base;

  for (const seg of path) {
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX_TOKEN_PATTERN.test(seg)) {
        throw new JsonLookupError(
          "EXPECTED_ARRAY_INDEX",
          seg,
          `Expected array index, got '${seg}'`,
        );
      }

      const idx = Number(seg);

      if (idx < 0 || idx >= cur.length) {
        throw new JsonLookupError("INDEX_OUT_OF_BOUNDS", seg, `Index out of bounds at '${seg}'`);
      }

      cur = cur[idx];
    } else if (cur && typeof cur === "object") {
      const obj = cur as Record<string, JsonValue>;
      if (!hasOwn(obj, seg)) {
        throw new JsonLookupError("MISSING_KEY", seg, `Missing key '${seg}'`);
      }

      cur = obj[seg];
    } else {
      throw new JsonLookupError(
        "NON_CONTAINER",
        seg,
        `Cannot traverse into non-container at '${seg}'`,
      );
    }
  }

  return cur as JsonValue;
}

/**
 * Compile RFC 6902 JSON Patch operations into CRDT intent operations.
 * `move`/`copy` are expanded to `add` + optional `remove`. Array indices
 * and the `"-"` append token are resolved against the base JSON.
 * @param baseJson - The base JSON value for resolving paths.
 * @param patch - Array of JSON Patch operations.
 * @returns An array of `IntentOp` ready for `applyIntentsToCrdt`.
 */
export function compileJsonPatchToIntent(
  baseJson: JsonValue,
  patch: JsonPatchOp[],
  options: CompilePatchOptions = {},
): IntentOp[] {
  // Internal session hints are threaded from state.ts via structural typing.
  const internalOptions = options as CompilePatchOptions & InternalCompilePatchOptions;
  const semantics = options.semantics ?? "sequential";
  const opIndexOffset = internalOptions.opIndexOffset ?? 0;
  let workingBase: JsonValue = baseJson;
  const pointerCache = internalOptions.pointerCache ?? new Map<string, string[]>();
  const intents: IntentOp[] = [];

  for (let opIndex = 0; opIndex < patch.length; opIndex++) {
    const op = patch[opIndex]!;
    const absoluteOpIndex = opIndex + opIndexOffset;
    const compileBase = semantics === "sequential" ? workingBase : baseJson;
    intents.push(...compileSingleOp(compileBase, op, absoluteOpIndex, semantics, pointerCache));

    if (semantics === "sequential") {
      workingBase = applyPatchOpToJsonWithStructuralSharing(
        workingBase,
        op,
        absoluteOpIndex,
        pointerCache,
      );
    }
  }

  return intents;
}

/** Compile a single JSON Patch operation into CRDT intents. */
export function compileJsonPatchOpToIntent(
  baseJson: JsonValue,
  op: JsonPatchOp,
  options: CompilePatchOptions = {},
): IntentOp[] {
  // Internal session hints are threaded from state.ts via structural typing.
  const internalOptions = options as CompilePatchOptions & InternalCompilePatchOptions;
  const semantics = options.semantics ?? "sequential";
  const pointerCache = internalOptions.pointerCache ?? new Map<string, string[]>();
  const opIndex = internalOptions.opIndexOffset ?? 0;
  return compileSingleOp(baseJson, op, opIndex, semantics, pointerCache);
}

/**
 * Compute a JSON Patch delta between two JSON values.
 * By default arrays use a deterministic LCS strategy.
 * Pass `{ arrayStrategy: "atomic" }` for single-op array replacement.
 * Pass `{ arrayStrategy: "lcs-linear" }` for a lower-memory LCS variant.
 * Use `lcsLinearMaxCells` to optionally cap worst-case `lcs-linear` work and
 * fall back to an atomic array replacement for very large unmatched windows.
 * Pass `{ emitMoves: true }` or `{ emitCopies: true }` to opt into RFC 6902
 * move/copy emission when a deterministic rewrite is available.
 * @param base - The original JSON value.
 * @param next - The target JSON value.
 * @param options - Diff options.
 * @returns An array of JSON Patch operations that transform `base` into `next`.
 */
export function diffJsonPatch(
  base: JsonValue,
  next: JsonValue,
  options: DiffOptions = {},
): JsonPatchOp[] {
  const runtimeMode = options.jsonValidation ?? "none";
  const runtimeBase = coerceRuntimeJsonValue(base, runtimeMode);
  const runtimeNext = coerceRuntimeJsonValue(next, runtimeMode);
  const ops: JsonPatchOp[] = [];
  const path: string[] = [];
  diffValue(path, runtimeBase, runtimeNext, ops, options);
  return ops;
}

function diffValue(
  path: string[],
  base: JsonValue,
  next: JsonValue,
  ops: JsonPatchOp[],
  options: DiffOptions,
): void {
  const stack: DiffFrame[] = [{ kind: "value", base, next }];

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.kind === "path-pop") {
      path.pop();
      continue;
    }

    if (frame.kind === "object") {
      if (frame.index >= frame.sharedKeys.length) {
        continue;
      }

      const key = frame.sharedKeys[frame.index]!;
      stack.push({
        kind: "object",
        base: frame.base,
        next: frame.next,
        sharedKeys: frame.sharedKeys,
        index: frame.index + 1,
      });
      path.push(key);
      stack.push({ kind: "path-pop" });
      stack.push({
        kind: "value",
        base: frame.base[key]!,
        next: frame.next[key]!,
      });
      continue;
    }

    assertTraversalDepth(path.length);

    if (frame.base === frame.next) {
      continue;
    }

    const baseIsArray = Array.isArray(frame.base);
    const nextIsArray = Array.isArray(frame.next);
    if (baseIsArray || nextIsArray) {
      if (!baseIsArray || !nextIsArray) {
        ops.push({ op: "replace", path: stringifyJsonPointer(path), value: frame.next });
        continue;
      }

      if (jsonEquals(frame.base, frame.next)) {
        continue;
      }

      const arrayStrategy = options.arrayStrategy ?? "lcs";

      if (arrayStrategy === "lcs") {
        if (!diffArrayWithLcsMatrix(path, frame.base, frame.next, ops, options)) {
          ops.push({ op: "replace", path: stringifyJsonPointer(path), value: frame.next });
        }
        continue;
      }

      if (arrayStrategy === "lcs-linear") {
        if (!diffArrayWithLinearLcs(path, frame.base, frame.next, ops, options)) {
          ops.push({ op: "replace", path: stringifyJsonPointer(path), value: frame.next });
        }
        continue;
      }

      ops.push({ op: "replace", path: stringifyJsonPointer(path), value: frame.next });
      continue;
    }

    const baseIsObject = isPlainObject(frame.base);
    const nextIsObject = isPlainObject(frame.next);
    if (!baseIsObject || !nextIsObject) {
      ops.push({ op: "replace", path: stringifyJsonPointer(path), value: frame.next });
      continue;
    }

    const { sharedKeys, baseOnlyKeys, nextOnlyKeys } = collectObjectKeys(frame.base, frame.next);
    const hasStructuralChanges = baseOnlyKeys.length > 0 || nextOnlyKeys.length > 0;
    if (
      !hasStructuralChanges &&
      (path.length === 0 || sharedKeys.length > 1) &&
      jsonEquals(frame.base, frame.next)
    ) {
      continue;
    }

    emitObjectStructuralOps(
      path,
      frame.base,
      frame.next,
      sharedKeys,
      baseOnlyKeys,
      nextOnlyKeys,
      ops,
      options,
    );

    if (sharedKeys.length > 0) {
      stack.push({
        kind: "object",
        base: frame.base,
        next: frame.next,
        sharedKeys,
        index: 0,
      });
    }
  }
}

function collectObjectKeys(
  base: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
): ObjectKeyGroups {
  const baseKeys = Object.keys(base).sort();
  const nextKeys = Object.keys(next).sort();
  const baseOnlyKeys: string[] = [];
  const nextOnlyKeys: string[] = [];
  const sharedKeys: string[] = [];

  let baseIndex = 0;
  let nextIndex = 0;

  while (baseIndex < baseKeys.length && nextIndex < nextKeys.length) {
    const baseKey = baseKeys[baseIndex]!;
    const nextKey = nextKeys[nextIndex]!;

    if (baseKey === nextKey) {
      sharedKeys.push(baseKey);
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (baseKey < nextKey) {
      baseOnlyKeys.push(baseKey);
      baseIndex += 1;
      continue;
    }

    nextOnlyKeys.push(nextKey);
    nextIndex += 1;
  }

  while (baseIndex < baseKeys.length) {
    baseOnlyKeys.push(baseKeys[baseIndex]!);
    baseIndex += 1;
  }

  while (nextIndex < nextKeys.length) {
    nextOnlyKeys.push(nextKeys[nextIndex]!);
    nextIndex += 1;
  }

  return { sharedKeys, baseOnlyKeys, nextOnlyKeys };
}

function emitObjectStructuralOps(
  path: string[],
  base: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
  sharedKeys: string[],
  baseOnlyKeys: string[],
  nextOnlyKeys: string[],
  ops: JsonPatchOp[],
  options: DiffOptions,
): void {
  if (!options.emitMoves && !options.emitCopies) {
    for (const baseKey of baseOnlyKeys) {
      path.push(baseKey);
      ops.push({ op: "remove", path: stringifyJsonPointer(path) });
      path.pop();
    }

    for (const nextKey of nextOnlyKeys) {
      path.push(nextKey);
      ops.push({
        op: "add",
        path: stringifyJsonPointer(path),
        value: next[nextKey]!,
      });
      path.pop();
    }

    return;
  }

  const structuralKeyCache = new WeakMap<object, string>();
  const matchedMoveSources = new Set<string>();
  const moveTargets = new Map<string, string>();
  if (options.emitMoves) {
    const moveSourceBuckets = new Map<string, string[]>();
    for (const baseKey of baseOnlyKeys) {
      insertObjectSourceBucket(moveSourceBuckets, baseKey, base[baseKey]!, structuralKeyCache);
    }

    for (const nextKey of nextOnlyKeys) {
      const bucket = moveSourceBuckets.get(stableJsonValueKey(next[nextKey]!, structuralKeyCache));
      if (!bucket) {
        continue;
      }

      if (bucket.length > 0) {
        const candidate = bucket.shift()!;
        matchedMoveSources.add(candidate);
        moveTargets.set(nextKey, candidate);
      }
    }
  }

  const copySourceBuckets = new Map<string, string[]>();
  for (const key of sharedKeys) {
    if (!jsonEquals(base[key]!, next[key]!)) {
      continue;
    }

    insertObjectSourceBucket(copySourceBuckets, key, base[key]!, structuralKeyCache);
  }

  for (const nextKey of nextOnlyKeys) {
    path.push(nextKey);
    const targetPath = stringifyJsonPointer(path);
    path.pop();

    const moveSource = moveTargets.get(nextKey);
    if (moveSource !== undefined) {
      path.push(moveSource);
      const fromPath = stringifyJsonPointer(path);
      path.pop();
      ops.push({ op: "move", from: fromPath, path: targetPath });
      insertObjectSourceBucket(copySourceBuckets, nextKey, next[nextKey]!, structuralKeyCache);
      continue;
    }

    if (options.emitCopies) {
      const copySource = findObjectCopySource(
        copySourceBuckets,
        next[nextKey]!,
        structuralKeyCache,
      );
      if (copySource !== undefined) {
        path.push(copySource);
        const fromPath = stringifyJsonPointer(path);
        path.pop();
        ops.push({ op: "copy", from: fromPath, path: targetPath });
        insertObjectSourceBucket(copySourceBuckets, nextKey, next[nextKey]!, structuralKeyCache);
        continue;
      }
    }

    ops.push({
      op: "add",
      path: targetPath,
      value: next[nextKey]!,
    });
    insertObjectSourceBucket(copySourceBuckets, nextKey, next[nextKey]!, structuralKeyCache);
  }

  for (const baseKey of baseOnlyKeys) {
    if (matchedMoveSources.has(baseKey)) {
      continue;
    }

    path.push(baseKey);
    ops.push({ op: "remove", path: stringifyJsonPointer(path) });
    path.pop();
  }
}

function insertObjectSourceBucket(
  buckets: Map<string, string[]>,
  key: string,
  value: JsonValue,
  structuralKeyCache: WeakMap<object, string>,
): void {
  const bucketKey = stableJsonValueKey(value, structuralKeyCache);
  const bucket = buckets.get(bucketKey);
  if (bucket) {
    insertSortedKey(bucket, key);
    return;
  }

  buckets.set(bucketKey, [key]);
}

function findObjectCopySource(
  copySourceBuckets: ReadonlyMap<string, readonly string[]>,
  target: JsonValue,
  structuralKeyCache: WeakMap<object, string>,
): string | undefined {
  return copySourceBuckets.get(stableJsonValueKey(target, structuralKeyCache))?.[0];
}

function insertSortedKey(keys: string[], key: string): void {
  let low = 0;
  let high = keys.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (keys[mid]! < key) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  keys.splice(low, 0, key);
}

function diffArrayWithLcsMatrix(
  path: string[],
  base: JsonValue[],
  next: JsonValue[],
  ops: JsonPatchOp[],
  options: DiffOptions,
): boolean {
  const window = trimEqualArrayEdges(base, next);
  const baseStart = window.baseStart;
  const nextStart = window.nextStart;
  const n = window.unmatchedBaseLength;
  const m = window.unmatchedNextLength;

  if (!shouldUseLcsDiff(n, m, options.lcsMaxCells)) {
    return false;
  }

  if (n === 0 && m === 0) {
    return true;
  }

  const steps: ArrayDiffStep[] = [];
  buildArrayEditScriptWithMatrix(
    base,
    baseStart,
    baseStart + n,
    next,
    nextStart,
    nextStart + m,
    steps,
  );
  pushArrayPatchOps(path, window.prefixLength, steps, ops, base, options);
  return true;
}

function diffArrayWithLinearLcs(
  path: string[],
  base: JsonValue[],
  next: JsonValue[],
  ops: JsonPatchOp[],
  options: DiffOptions,
): boolean {
  const window = trimEqualArrayEdges(base, next);
  if (!shouldUseLinearLcsDiff(window.unmatchedBaseLength, window.unmatchedNextLength, options)) {
    return false;
  }

  const steps: ArrayDiffStep[] = [];
  buildArrayEditScriptLinearSpace(
    base,
    window.baseStart,
    window.baseStart + window.unmatchedBaseLength,
    next,
    window.nextStart,
    window.nextStart + window.unmatchedNextLength,
    steps,
  );

  pushArrayPatchOps(path, window.prefixLength, steps, ops, base, options);
  return true;
}

function trimEqualArrayEdges(base: JsonValue[], next: JsonValue[]): TrimmedArrayWindow {
  const baseLength = base.length;
  const nextLength = next.length;
  let prefixLength = 0;

  while (
    prefixLength < baseLength &&
    prefixLength < nextLength &&
    jsonEquals(base[prefixLength]!, next[prefixLength]!)
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseLength - prefixLength &&
    suffixLength < nextLength - prefixLength &&
    jsonEquals(base[baseLength - 1 - suffixLength]!, next[nextLength - 1 - suffixLength]!)
  ) {
    suffixLength += 1;
  }

  return {
    baseStart: prefixLength,
    nextStart: prefixLength,
    prefixLength,
    unmatchedBaseLength: baseLength - prefixLength - suffixLength,
    unmatchedNextLength: nextLength - prefixLength - suffixLength,
  };
}

function buildArrayEditScriptLinearSpace(
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
  steps: ArrayDiffStep[],
): void {
  const unmatchedBaseLength = baseEnd - baseStart;
  const unmatchedNextLength = nextEnd - nextStart;

  if (unmatchedBaseLength === 0) {
    for (let nextIndex = nextStart; nextIndex < nextEnd; nextIndex++) {
      steps.push({ kind: "add", value: next[nextIndex]! });
    }
    return;
  }

  if (unmatchedNextLength === 0) {
    for (let baseIndex = baseStart; baseIndex < baseEnd; baseIndex++) {
      steps.push({ kind: "remove" });
    }
    return;
  }

  if (unmatchedBaseLength === 1) {
    pushSingleBaseElementSteps(base, baseStart, next, nextStart, nextEnd, steps);
    return;
  }

  if (unmatchedNextLength === 1) {
    pushSingleNextElementSteps(base, baseStart, baseEnd, next, nextStart, steps);
    return;
  }

  if (shouldUseMatrixBaseCase(unmatchedBaseLength, unmatchedNextLength)) {
    buildArrayEditScriptWithMatrix(base, baseStart, baseEnd, next, nextStart, nextEnd, steps);
    return;
  }

  const baseMid = baseStart + Math.floor(unmatchedBaseLength / 2);
  const forwardScores = computeLcsPrefixLengths(base, baseStart, baseMid, next, nextStart, nextEnd);
  const reverseScores = computeLcsSuffixLengths(base, baseMid, baseEnd, next, nextStart, nextEnd);

  let bestOffset = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let offset = 0; offset <= unmatchedNextLength; offset++) {
    const score = forwardScores[offset]! + reverseScores[offset]!;

    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  const nextMid = nextStart + bestOffset;
  buildArrayEditScriptLinearSpace(base, baseStart, baseMid, next, nextStart, nextMid, steps);
  buildArrayEditScriptLinearSpace(base, baseMid, baseEnd, next, nextMid, nextEnd, steps);
}

function pushSingleBaseElementSteps(
  base: JsonValue[],
  baseStart: number,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
  steps: ArrayDiffStep[],
): void {
  const matchIndex = findFirstMatchingIndexInNext(base[baseStart]!, next, nextStart, nextEnd);

  if (matchIndex === -1) {
    steps.push({ kind: "remove" });

    for (let nextIndex = nextStart; nextIndex < nextEnd; nextIndex++) {
      steps.push({ kind: "add", value: next[nextIndex]! });
    }
    return;
  }

  for (let nextIndex = nextStart; nextIndex < matchIndex; nextIndex++) {
    steps.push({ kind: "add", value: next[nextIndex]! });
  }

  steps.push({ kind: "equal" });

  for (let nextIndex = matchIndex + 1; nextIndex < nextEnd; nextIndex++) {
    steps.push({ kind: "add", value: next[nextIndex]! });
  }
}

function pushSingleNextElementSteps(
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
  next: JsonValue[],
  nextStart: number,
  steps: ArrayDiffStep[],
): void {
  const matchIndex = findFirstMatchingIndexInBase(next[nextStart]!, base, baseStart, baseEnd);

  if (matchIndex === -1) {
    for (let baseIndex = baseStart; baseIndex < baseEnd; baseIndex++) {
      steps.push({ kind: "remove" });
    }

    steps.push({ kind: "add", value: next[nextStart]! });
    return;
  }

  for (let baseIndex = baseStart; baseIndex < matchIndex; baseIndex++) {
    steps.push({ kind: "remove" });
  }

  steps.push({ kind: "equal" });

  for (let baseIndex = matchIndex + 1; baseIndex < baseEnd; baseIndex++) {
    steps.push({ kind: "remove" });
  }
}

function findFirstMatchingIndexInNext(
  target: JsonValue,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
): number {
  for (let nextIndex = nextStart; nextIndex < nextEnd; nextIndex++) {
    if (jsonEquals(target, next[nextIndex]!)) {
      return nextIndex;
    }
  }

  return -1;
}

function findFirstMatchingIndexInBase(
  target: JsonValue,
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
): number {
  for (let baseIndex = baseStart; baseIndex < baseEnd; baseIndex++) {
    if (jsonEquals(target, base[baseIndex]!)) {
      return baseIndex;
    }
  }

  return -1;
}

function shouldUseMatrixBaseCase(baseLength: number, nextLength: number): boolean {
  return (baseLength + 1) * (nextLength + 1) <= LINEAR_LCS_MATRIX_BASE_CASE_MAX_CELLS;
}

function buildArrayEditScriptWithMatrix(
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
  steps: ArrayDiffStep[],
): void {
  const unmatchedBaseLength = baseEnd - baseStart;
  const unmatchedNextLength = nextEnd - nextStart;
  const lcs: number[][] = Array.from({ length: unmatchedBaseLength + 1 }, () =>
    Array(unmatchedNextLength + 1).fill(0),
  );

  for (let baseOffset = unmatchedBaseLength - 1; baseOffset >= 0; baseOffset--) {
    for (let nextOffset = unmatchedNextLength - 1; nextOffset >= 0; nextOffset--) {
      if (jsonEquals(base[baseStart + baseOffset]!, next[nextStart + nextOffset]!)) {
        lcs[baseOffset]![nextOffset] = 1 + lcs[baseOffset + 1]![nextOffset + 1]!;
      } else {
        lcs[baseOffset]![nextOffset] = Math.max(
          lcs[baseOffset + 1]![nextOffset]!,
          lcs[baseOffset]![nextOffset + 1]!,
        );
      }
    }
  }

  let baseOffset = 0;
  let nextOffset = 0;

  while (baseOffset < unmatchedBaseLength || nextOffset < unmatchedNextLength) {
    if (
      baseOffset < unmatchedBaseLength &&
      nextOffset < unmatchedNextLength &&
      jsonEquals(base[baseStart + baseOffset]!, next[nextStart + nextOffset]!)
    ) {
      steps.push({ kind: "equal" });
      baseOffset += 1;
      nextOffset += 1;
      continue;
    }

    const lcsDown = baseOffset < unmatchedBaseLength ? lcs[baseOffset + 1]![nextOffset]! : -1;
    const lcsRight = nextOffset < unmatchedNextLength ? lcs[baseOffset]![nextOffset + 1]! : -1;

    if (
      nextOffset < unmatchedNextLength &&
      (baseOffset === unmatchedBaseLength || lcsRight > lcsDown)
    ) {
      steps.push({ kind: "add", value: next[nextStart + nextOffset]! });
      nextOffset += 1;
      continue;
    }

    if (baseOffset < unmatchedBaseLength) {
      steps.push({ kind: "remove" });
      baseOffset += 1;
    }
  }
}

function computeLcsPrefixLengths(
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
): Int32Array {
  const unmatchedNextLength = nextEnd - nextStart;
  let previousRow = new Int32Array(unmatchedNextLength + 1);
  let currentRow = new Int32Array(unmatchedNextLength + 1);

  for (let baseIndex = baseStart; baseIndex < baseEnd; baseIndex++) {
    for (let nextOffset = 0; nextOffset < unmatchedNextLength; nextOffset++) {
      if (jsonEquals(base[baseIndex]!, next[nextStart + nextOffset]!)) {
        currentRow[nextOffset + 1] = previousRow[nextOffset]! + 1;
      } else {
        currentRow[nextOffset + 1] = Math.max(
          previousRow[nextOffset + 1]!,
          currentRow[nextOffset]!,
        );
      }
    }

    const nextPreviousRow = currentRow;
    currentRow = previousRow;
    previousRow = nextPreviousRow;
    currentRow.fill(0);
  }

  return previousRow;
}

function computeLcsSuffixLengths(
  base: JsonValue[],
  baseStart: number,
  baseEnd: number,
  next: JsonValue[],
  nextStart: number,
  nextEnd: number,
): Int32Array {
  const unmatchedNextLength = nextEnd - nextStart;
  let previousRow = new Int32Array(unmatchedNextLength + 1);
  let currentRow = new Int32Array(unmatchedNextLength + 1);

  for (let baseIndex = baseEnd - 1; baseIndex >= baseStart; baseIndex--) {
    for (let nextOffset = unmatchedNextLength - 1; nextOffset >= 0; nextOffset--) {
      if (jsonEquals(base[baseIndex]!, next[nextStart + nextOffset]!)) {
        currentRow[nextOffset] = previousRow[nextOffset + 1]! + 1;
      } else {
        currentRow[nextOffset] = Math.max(previousRow[nextOffset]!, currentRow[nextOffset + 1]!);
      }
    }

    const nextPreviousRow = currentRow;
    currentRow = previousRow;
    previousRow = nextPreviousRow;
    currentRow.fill(0);
  }

  return previousRow;
}

function pushArrayPatchOps(
  path: string[],
  startIndex: number,
  steps: ArrayDiffStep[],
  ops: JsonPatchOp[],
  base: JsonValue[],
  options: DiffOptions,
): void {
  const localOps: JsonPatchOp[] = [];
  let index = startIndex;

  for (const step of steps) {
    if (step.kind === "equal") {
      index += 1;
      continue;
    }

    const indexSegment = String(index);
    path.push(indexSegment);

    if (step.kind === "add") {
      localOps.push({
        op: "add",
        path: stringifyJsonPointer(path),
        value: step.value,
      });
      index += 1;
      path.pop();
      continue;
    }

    localOps.push({
      op: "remove",
      path: stringifyJsonPointer(path),
    });
    path.pop();
  }

  ops.push(...finalizeArrayOps(path, base, localOps, options));
}

function shouldUseLcsDiff(baseLength: number, nextLength: number, lcsMaxCells?: number): boolean {
  if (lcsMaxCells === Number.POSITIVE_INFINITY) {
    return true;
  }

  const cap = lcsMaxCells ?? DEFAULT_LCS_MAX_CELLS;
  if (!Number.isFinite(cap) || cap < 1) {
    return false;
  }

  const matrixCells = (baseLength + 1) * (nextLength + 1);
  return matrixCells <= cap;
}

function shouldUseLinearLcsDiff(
  baseLength: number,
  nextLength: number,
  options: DiffOptions,
): boolean {
  const cap = options.lcsLinearMaxCells;
  if (cap === undefined || cap === Number.POSITIVE_INFINITY) {
    return true;
  }

  if (!Number.isFinite(cap) || cap < 1) {
    return false;
  }

  const estimatedCells = (baseLength + 1) * (nextLength + 1);
  return estimatedCells <= cap;
}

function finalizeArrayOps(
  arrayPath: string[],
  base: JsonValue[],
  ops: JsonPatchOp[],
  options: DiffOptions,
): JsonPatchOp[] {
  if (ops.length === 0) {
    return [];
  }

  if (!options.emitMoves && !options.emitCopies) {
    return compactArrayOps(ops);
  }

  const out: JsonPatchOp[] = [];
  // Keep prefix/suffix elements in the shadow array so copy detection can
  // reference stable sources outside the trimmed diff window.
  const working = base.slice();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const next = ops[i + 1];

    if (op.op === "remove" && next && next.op === "add") {
      const removedValue = working[getArrayOpIndex(op.path, arrayPath)]!;
      const valuesMatch = jsonEquals(removedValue, next.value);

      if (op.path === next.path) {
        const replaceOp: JsonPatchOp = { op: "replace", path: op.path, value: next.value };
        out.push(replaceOp);
        applyArrayOptimizationOp(working, replaceOp, arrayPath);
        i += 1;
        continue;
      }

      if (options.emitMoves && valuesMatch) {
        const moveOp: JsonPatchOp = { op: "move", from: op.path, path: next.path };
        out.push(moveOp);
        applyArrayOptimizationOp(working, moveOp, arrayPath);
        i += 1;
        continue;
      }

      if (valuesMatch) {
        out.push(op);
        applyArrayOptimizationOp(working, op, arrayPath);
        out.push(next);
        applyArrayOptimizationOp(working, next, arrayPath);
        i += 1;
        continue;
      }

      out.push(op);
      applyArrayOptimizationOp(working, op, arrayPath);
      continue;
    }

    if (op.op === "add" && next && next.op === "remove") {
      const targetIndex = getArrayOpIndex(op.path, arrayPath);
      const removeIndex = getArrayOpIndex(next.path, arrayPath);
      const sourceIndex = removeIndex - (targetIndex <= removeIndex ? 1 : 0);
      const matchesPendingRemove =
        sourceIndex >= 0 &&
        sourceIndex < working.length &&
        jsonEquals(working[sourceIndex]!, op.value);

      if (options.emitMoves && matchesPendingRemove) {
        const moveOp: JsonPatchOp = {
          op: "move",
          from: stringifyJsonPointer([...arrayPath, String(sourceIndex)]),
          path: op.path,
        };
        out.push(moveOp);
        applyArrayOptimizationOp(working, moveOp, arrayPath);
        i += 1;
        continue;
      }

      if (matchesPendingRemove) {
        // Keep matching add/remove pairs together so copy detection does not
        // rewrite them into copy+remove when moves are disabled.
        out.push(op);
        applyArrayOptimizationOp(working, op, arrayPath);
        out.push(next);
        applyArrayOptimizationOp(working, next, arrayPath);
        i += 1;
        continue;
      }
    }

    if (op.op === "add" && options.emitCopies) {
      const copySourceIndex = findArrayCopySourceIndex(working, op.value);
      if (copySourceIndex !== -1) {
        const copyOp: JsonPatchOp = {
          op: "copy",
          from: stringifyJsonPointer([...arrayPath, String(copySourceIndex)]),
          path: op.path,
        };
        out.push(copyOp);
        applyArrayOptimizationOp(working, copyOp, arrayPath);
        continue;
      }
    }

    out.push(op);
    applyArrayOptimizationOp(working, op, arrayPath);
  }

  return out;
}

export function stableJsonValueKey(
  value: JsonValue,
  structuralKeyCache?: WeakMap<object, string>,
): string {
  if (value !== null && typeof value === "object") {
    const cachedValue = structuralKeyCache?.get(value);
    if (cachedValue !== undefined) {
      return cachedValue;
    }
  }

  const stack: StableJsonKeyFrame[] = [{ kind: "value", value, depth: 0 }];
  const results: string[] = [];

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.kind === "array") {
      const childParts = results.splice(frame.startIndex);
      const stableKey = `[${childParts.join(",")}]`;
      structuralKeyCache?.set(frame.value, stableKey);
      results.push(stableKey);
      continue;
    }

    if (frame.kind === "object") {
      const childParts = results.splice(frame.startIndex);
      const stableKey = `{${frame.keys
        .map((key, index) => `${JSON.stringify(key)}:${childParts[index]!}`)
        .join(",")}}`;
      structuralKeyCache?.set(frame.value, stableKey);
      results.push(stableKey);
      continue;
    }

    assertTraversalDepth(frame.depth);

    if (frame.value === null || typeof frame.value !== "object") {
      results.push(JSON.stringify(frame.value));
      continue;
    }

    const cachedValue = structuralKeyCache?.get(frame.value);
    if (cachedValue !== undefined) {
      results.push(cachedValue);
      continue;
    }

    if (Array.isArray(frame.value)) {
      const startIndex = results.length;
      stack.push({ kind: "array", value: frame.value, startIndex });
      for (let index = frame.value.length - 1; index >= 0; index--) {
        stack.push({
          kind: "value",
          value: frame.value[index]!,
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    const keys = Object.keys(frame.value).sort();
    const startIndex = results.length;
    stack.push({ kind: "object", value: frame.value, keys, startIndex });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key]!,
        depth: frame.depth + 1,
      });
    }
  }

  return results[0]!;
}

function compactArrayOps(ops: JsonPatchOp[]): JsonPatchOp[] {
  const out: JsonPatchOp[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const next = ops[i + 1];

    if (op.op === "remove" && next && next.op === "add" && op.path === next.path) {
      out.push({ op: "replace", path: op.path, value: next.value });
      i += 1;
      continue;
    }

    out.push(op);
  }

  return out;
}

function findArrayCopySourceIndex(working: JsonValue[], value: JsonValue): number {
  for (let index = 0; index < working.length; index++) {
    if (jsonEquals(working[index]!, value)) {
      return index;
    }
  }

  return -1;
}

function getArrayOpIndex(ptr: string, arrayPath: string[]): number {
  const parsed = parseJsonPointer(ptr);
  if (parsed.length !== arrayPath.length + 1) {
    throw new Error(`Expected array operation under ${stringifyJsonPointer(arrayPath)}: ${ptr}`);
  }

  for (let index = 0; index < arrayPath.length; index++) {
    if (parsed[index] !== arrayPath[index]) {
      throw new Error(`Expected array operation under ${stringifyJsonPointer(arrayPath)}: ${ptr}`);
    }
  }

  const token = parsed[arrayPath.length]!;
  if (!ARRAY_INDEX_TOKEN_PATTERN.test(token)) {
    throw new Error(`Expected numeric array index at ${ptr}`);
  }

  return Number(token);
}

function applyArrayOptimizationOp(
  working: JsonValue[],
  op: JsonPatchOp,
  arrayPath: string[],
): void {
  if (op.op === "add") {
    working.splice(getArrayOpIndex(op.path, arrayPath), 0, structuredClone(op.value));
    return;
  }

  if (op.op === "remove") {
    working.splice(getArrayOpIndex(op.path, arrayPath), 1);
    return;
  }

  if (op.op === "replace") {
    working[getArrayOpIndex(op.path, arrayPath)] = structuredClone(op.value);
    return;
  }

  if (op.op === "copy") {
    const fromIndex = getArrayOpIndex(op.from, arrayPath);
    if (fromIndex < 0 || fromIndex >= working.length) {
      throw new Error(
        `applyArrayOptimizationOp: copy from index ${fromIndex} is out of bounds (length ${working.length})`,
      );
    }

    const value = structuredClone(working[fromIndex]!);
    working.splice(getArrayOpIndex(op.path, arrayPath), 0, value);
    return;
  }

  if (op.op === "move") {
    const fromIndex = getArrayOpIndex(op.from, arrayPath);
    if (fromIndex < 0 || fromIndex >= working.length) {
      throw new Error(
        `applyArrayOptimizationOp: move from index ${fromIndex} is out of bounds (length ${working.length})`,
      );
    }

    const [value] = working.splice(fromIndex, 1);
    working.splice(getArrayOpIndex(op.path, arrayPath), 0, value!);
    return;
  }

  throw new Error(`applyArrayOptimizationOp: unexpected op type "${op.op}"`);
}

function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Deep equality check for JSON values (null-safe, handles arrays and objects). */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  const stack: JsonEqualFrame[] = [{ left: a, right: b, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (frame.left === frame.right) {
      continue;
    }

    if (frame.left === null || frame.right === null) {
      return false;
    }

    if (Array.isArray(frame.left) || Array.isArray(frame.right)) {
      if (!Array.isArray(frame.left) || !Array.isArray(frame.right)) {
        return false;
      }

      if (frame.left.length !== frame.right.length) {
        return false;
      }

      for (let index = frame.left.length - 1; index >= 0; index--) {
        stack.push({
          left: frame.left[index]!,
          right: frame.right[index]!,
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    if (!isPlainObject(frame.left) || !isPlainObject(frame.right)) {
      return false;
    }

    const leftKeys = Object.keys(frame.left);
    const rightKeys = Object.keys(frame.right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (let index = leftKeys.length - 1; index >= 0; index--) {
      const key = leftKeys[index]!;
      if (!hasOwn(frame.right, key)) {
        return false;
      }

      stack.push({
        left: frame.left[key]!,
        right: frame.right[key]!,
        depth: frame.depth + 1,
      });
    }
  }

  return true;
}

function isPlainObject(value: unknown): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ARRAY_INDEX_TOKEN_PATTERN = /^(0|[1-9][0-9]*)$/;

function hasOwn(value: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__";
}

function pathValueAt(base: JsonValue, path: string[]): JsonValue {
  if (path.length === 0) {
    return base;
  }

  return getAtJson(base, path);
}

function assertNever(_value: never, message: string): never {
  throw new Error(message);
}

function compileSingleOp(
  baseJson: JsonValue,
  op: JsonPatchOp,
  opIndex: number,
  semantics: "sequential" | "base",
  pointerCache: Map<string, string[]>,
): IntentOp[] {
  if (op.op === "test") {
    return [
      {
        t: "Test",
        path: parsePointerOrThrow(op.path, op.path, opIndex, pointerCache),
        value: op.value,
      },
    ];
  }

  if (op.op === "copy" || op.op === "move") {
    const fromPath = parsePointerOrThrow(op.from, op.from, opIndex, pointerCache);
    const toPath = parsePointerOrThrow(op.path, op.path, opIndex, pointerCache);

    if (op.op === "move" && isStrictDescendantPath(fromPath, toPath)) {
      throw compileError(
        "INVALID_MOVE",
        `cannot move a value into one of its descendants at ${op.path}`,
        op.path,
        opIndex,
      );
    }

    const val = structuredClone(lookupValueOrThrow(baseJson, fromPath, op.from, opIndex));

    if (op.op === "move" && isSamePath(fromPath, toPath)) {
      return [];
    }

    if (op.op === "move" && semantics === "sequential") {
      const removeOp: JsonPatchOp = { op: "remove", path: op.from };
      const addOp: JsonPatchOp = { op: "add", path: op.path, value: val };
      const baseAfterRemove = applyPatchOpToJson(baseJson, removeOp, opIndex, pointerCache);

      return [
        ...compileSingleOp(baseJson, removeOp, opIndex, semantics, pointerCache),
        ...compileSingleOp(baseAfterRemove, addOp, opIndex, semantics, pointerCache),
      ];
    }

    const out = compileSingleOp(
      baseJson,
      { op: "add", path: op.path, value: val },
      opIndex,
      semantics,
      pointerCache,
    );

    if (op.op === "move") {
      out.push(
        ...compileSingleOp(
          baseJson,
          { op: "remove", path: op.from },
          opIndex,
          semantics,
          pointerCache,
        ),
      );
    }

    return out;
  }

  const path = parsePointerOrThrow(op.path, op.path, opIndex, pointerCache);

  // Root replacement: treat as atomic set.
  if (path.length === 0) {
    if (op.op === "replace" || op.op === "add") {
      return [{ t: "ObjSet", path: [], key: ROOT_KEY, value: op.value }];
    }

    throw compileError(
      "INVALID_TARGET",
      "remove at root path is not supported in RFC-compliant mode",
      op.path,
      opIndex,
    );
  }

  const parent = path.slice(0, -1);
  const token = path[path.length - 1]!;
  const parentPath = stringifyJsonPointer(parent);

  const parentValue = getParentValue(baseJson, parent, opIndex);

  if (Array.isArray(parentValue)) {
    const index = parseArrayIndexToken(token, op.op, parentValue.length, op.path, opIndex);

    if (op.op === "add") {
      return [{ t: "ArrInsert", path: parent, index, value: op.value }];
    }

    if (op.op === "remove") {
      return [{ t: "ArrDelete", path: parent, index }];
    }

    if (op.op === "replace") {
      return [{ t: "ArrReplace", path: parent, index, value: op.value }];
    }

    return assertNever(op, "Unsupported op at array path");
  }

  if (!isPlainObject(parentValue)) {
    throw compileError(
      "INVALID_TARGET",
      `expected object or array parent at ${parentPath}`,
      parentPath,
      opIndex,
    );
  }

  if (isUnsafeObjectKey(token)) {
    throw compileError("INVALID_POINTER", `unsafe object key at ${op.path}`, op.path, opIndex);
  }

  if ((op.op === "replace" || op.op === "remove") && !hasOwn(parentValue, token)) {
    throw compileError("MISSING_TARGET", `missing key ${token} at ${parentPath}`, op.path, opIndex);
  }

  if (op.op === "add") {
    return [{ t: "ObjSet", path: parent, key: token, value: op.value, mode: "add" }];
  }

  if (op.op === "replace") {
    return [{ t: "ObjSet", path: parent, key: token, value: op.value, mode: "replace" }];
  }

  if (op.op === "remove") {
    return [{ t: "ObjRemove", path: parent, key: token }];
  }

  return assertNever(op, "Unsupported op");
}

function applyPatchOpToJson(
  baseJson: JsonValue,
  op: JsonPatchOp,
  opIndex: number,
  pointerCache: Map<string, string[]>,
): JsonValue {
  return applyPatchOpToJsonWithStructuralSharing(baseJson, op, opIndex, pointerCache);
}

function applyPatchOpToJsonWithStructuralSharing(
  doc: JsonValue,
  op: JsonPatchOp,
  opIndex: number,
  pointerCache: Map<string, string[]>,
): JsonValue {
  if (op.op === "test") {
    return doc;
  }

  if (op.op === "copy" || op.op === "move") {
    const fromPath = parsePointerOrThrow(op.from, op.from, opIndex, pointerCache);
    const value = structuredClone(lookupValueOrThrow(doc, fromPath, op.from, opIndex));
    const docAfterRemove =
      op.op === "move"
        ? applyPatchOpToJsonWithStructuralSharing(
            doc,
            { op: "remove", path: op.from },
            opIndex,
            pointerCache,
          )
        : doc;
    return applyPatchOpToJsonWithStructuralSharing(
      docAfterRemove,
      { op: "add", path: op.path, value },
      opIndex,
      pointerCache,
    );
  }

  const path = parsePointerOrThrow(op.path, op.path, opIndex, pointerCache);
  if (path.length === 0) {
    if (op.op === "add" || op.op === "replace") {
      return structuredClone(op.value);
    }

    throw compileError(
      "INVALID_TARGET",
      "remove at root path is not supported in RFC-compliant mode",
      op.path,
      opIndex,
    );
  }

  const parentPath = path.slice(0, -1);
  const token = path[path.length - 1]!;
  const parentValue =
    parentPath.length === 0 ? doc : lookupValueOrThrow(doc, parentPath, op.path, opIndex);

  if (Array.isArray(parentValue)) {
    const index = parseArrayIndexToken(token, op.op, parentValue.length, op.path, opIndex);
    const { root, parent } = cloneJsonPathToParent(doc, parentPath);
    const clonedParent = parent as JsonValue[];

    if (op.op === "add") {
      const insertAt = index === Number.POSITIVE_INFINITY ? clonedParent.length : index;
      clonedParent.splice(insertAt, 0, structuredClone(op.value));
      return root;
    }

    if (op.op === "replace") {
      clonedParent[index] = structuredClone(op.value);
      return root;
    }

    clonedParent.splice(index, 1);
    return root;
  }

  if (!isPlainObject(parentValue)) {
    throw compileError(
      "INVALID_TARGET",
      `expected object or array parent at ${stringifyJsonPointer(parentPath)}`,
      op.path,
      opIndex,
    );
  }

  if (isUnsafeObjectKey(token)) {
    throw compileError("INVALID_POINTER", `unsafe object key at ${op.path}`, op.path, opIndex);
  }

  const { root, parent } = cloneJsonPathToParent(doc, parentPath);
  const clonedParent = parent as Record<string, JsonValue>;

  if (op.op === "add" || op.op === "replace") {
    clonedParent[token] = structuredClone(op.value);
    return root;
  }

  delete clonedParent[token];
  return root;
}

function cloneJsonContainerShallow(value: JsonValue): JsonValue[] | Record<string, JsonValue> {
  if (Array.isArray(value)) {
    return value.slice();
  }

  if (isPlainObject(value)) {
    return { ...value };
  }

  throw new Error("Expected JSON container");
}

function cloneJsonPathToParent(
  doc: JsonValue,
  parentPath: string[],
): { root: JsonValue; parent: JsonValue[] | Record<string, JsonValue> } {
  const root = cloneJsonContainerShallow(doc);

  if (parentPath.length === 0) {
    return { root, parent: root };
  }

  let sourceCur: JsonValue = doc;
  let targetCur: JsonValue[] | Record<string, JsonValue> = root;

  for (const segment of parentPath) {
    const nextSource = Array.isArray(sourceCur)
      ? sourceCur[Number(segment)]!
      : (sourceCur as Record<string, JsonValue>)[segment]!;
    const nextTarget = cloneJsonContainerShallow(nextSource);

    if (Array.isArray(targetCur)) {
      targetCur[Number(segment)] = nextTarget;
    } else {
      targetCur[segment] = nextTarget;
    }

    sourceCur = nextSource;
    targetCur = nextTarget;
  }

  return { root, parent: targetCur };
}

function parsePointerOrThrow(
  ptr: string,
  path: string,
  opIndex: number,
  pointerCache: Map<string, string[]>,
): string[] {
  const cached = pointerCache.get(ptr);
  if (cached) {
    // Return a copy so callers cannot mutate the cached pointer segments.
    return cached.slice();
  }

  try {
    const parsed = parseJsonPointer(ptr);
    pointerCache.set(ptr, parsed);
    return parsed.slice();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid pointer";
    throw compileError("INVALID_POINTER", message, path, opIndex);
  }
}

function lookupValueOrThrow(
  baseJson: JsonValue,
  path: string[],
  pointer: string,
  opIndex: number,
): JsonValue {
  try {
    return getAtJson(baseJson, path);
  } catch (error) {
    throw compileErrorFromLookup(error, pointer, opIndex);
  }
}

function getParentValue(baseJson: JsonValue, parent: string[], opIndex: number): JsonValue {
  if (parent.length === 0) {
    return baseJson;
  }

  try {
    return pathValueAt(baseJson, parent);
  } catch (error) {
    throw compileErrorFromLookup(error, stringifyJsonPointer(parent), opIndex);
  }
}

function parseArrayIndexToken(
  token: string,
  op: "add" | "remove" | "replace",
  arrLength: number,
  path: string,
  opIndex: number,
): number {
  if (token === "-") {
    if (op !== "add") {
      throw compileError(
        "INVALID_POINTER",
        `'-' index is only valid for add at ${path}`,
        path,
        opIndex,
      );
    }

    return Number.POSITIVE_INFINITY;
  }

  if (!ARRAY_INDEX_TOKEN_PATTERN.test(token)) {
    throw compileError("INVALID_POINTER", `expected array index at ${path}`, path, opIndex);
  }

  const index = Number(token);
  if (!Number.isSafeInteger(index)) {
    throw compileError("OUT_OF_BOUNDS", `array index is too large at ${path}`, path, opIndex);
  }

  if (op === "add") {
    if (index > arrLength) {
      throw compileError(
        "OUT_OF_BOUNDS",
        `index out of bounds at ${path}; expected 0..${arrLength}`,
        path,
        opIndex,
      );
    }
  } else if (index >= arrLength) {
    throw compileError(
      "OUT_OF_BOUNDS",
      `index out of bounds at ${path}; expected 0..${Math.max(arrLength - 1, 0)}`,
      path,
      opIndex,
    );
  }

  return index;
}

function compileErrorFromLookup(error: unknown, path: string, opIndex: number): PatchCompileError {
  const mapped = mapLookupErrorToPatchReason(error);
  return compileError(mapped.reason, mapped.message, path, opIndex);
}

export function mapLookupErrorToPatchReason(error: unknown): {
  reason: PatchErrorReason;
  message: string;
} {
  if (error instanceof JsonLookupError) {
    switch (error.code) {
      case "EXPECTED_ARRAY_INDEX":
        return { reason: "INVALID_POINTER", message: error.message };
      case "INDEX_OUT_OF_BOUNDS":
        return { reason: "OUT_OF_BOUNDS", message: error.message };
      case "MISSING_KEY":
        return { reason: "MISSING_PARENT", message: error.message };
      case "NON_CONTAINER":
        return { reason: "INVALID_TARGET", message: error.message };
      default:
        return { reason: "INVALID_PATCH", message: error.message };
    }
  }

  const message = error instanceof Error ? error.message : "invalid path";
  return { reason: "INVALID_PATCH", message };
}

function compileError(
  reason: PatchErrorReason,
  message: string,
  path: string,
  opIndex: number,
): PatchCompileError {
  return new PatchCompileError(reason, message, path, opIndex);
}

function isStrictDescendantPath(from: string[], to: string[]): boolean {
  if (to.length <= from.length) {
    return false;
  }

  for (let i = 0; i < from.length; i++) {
    if (from[i] !== to[i]) {
      return false;
    }
  }

  return true;
}

function isSamePath(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
