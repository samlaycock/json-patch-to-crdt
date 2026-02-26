import type {
  CompilePatchOptions,
  DiffOptions,
  IntentOp,
  JsonPatchOp,
  JsonValue,
  PatchErrorReason,
} from "./types";

import { coerceRuntimeJsonValue } from "./json-value";
import { ROOT_KEY } from "./types";

const DEFAULT_LCS_MAX_CELLS = 250_000;

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
  const semantics = options.semantics ?? "sequential";
  let workingBase: JsonValue = baseJson;
  const pointerCache = new Map<string, string[]>();
  const intents: IntentOp[] = [];

  for (let opIndex = 0; opIndex < patch.length; opIndex++) {
    const op = patch[opIndex]!;
    const compileBase = semantics === "sequential" ? workingBase : baseJson;
    intents.push(...compileSingleOp(compileBase, op, opIndex, semantics, pointerCache));

    if (semantics === "sequential") {
      workingBase = applyPatchOpToJsonWithStructuralSharing(workingBase, op, opIndex, pointerCache);
    }
  }

  return intents;
}

/**
 * Compute a JSON Patch delta between two JSON values.
 * By default arrays use a deterministic LCS strategy.
 * Pass `{ arrayStrategy: "atomic" }` for single-op array replacement.
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
  diffValue([], runtimeBase, runtimeNext, ops, options);
  return ops;
}

function diffValue(
  path: string[],
  base: JsonValue,
  next: JsonValue,
  ops: JsonPatchOp[],
  options: DiffOptions,
): void {
  if (jsonEquals(base, next)) {
    return;
  }

  if (Array.isArray(base) || Array.isArray(next)) {
    const arrayStrategy = options.arrayStrategy ?? "lcs";

    if (arrayStrategy === "lcs" && Array.isArray(base) && Array.isArray(next)) {
      if (!diffArray(path, base, next, ops, options.lcsMaxCells)) {
        ops.push({ op: "replace", path: stringifyJsonPointer(path), value: next });
      }
      return;
    }

    ops.push({ op: "replace", path: stringifyJsonPointer(path), value: next });
    return;
  }

  if (!isPlainObject(base) || !isPlainObject(next)) {
    ops.push({ op: "replace", path: stringifyJsonPointer(path), value: next });
    return;
  }

  const baseKeys = Object.keys(base).sort();
  const nextKeys = Object.keys(next).sort();
  const baseSet = new Set(baseKeys);
  const nextSet = new Set(nextKeys);

  for (const key of baseKeys) {
    if (!nextSet.has(key)) {
      ops.push({ op: "remove", path: stringifyJsonPointer([...path, key]) });
    }
  }

  for (const key of nextKeys) {
    if (!baseSet.has(key)) {
      const nextValue = next[key]!;
      ops.push({
        op: "add",
        path: stringifyJsonPointer([...path, key]),
        value: nextValue,
      });
    }
  }

  for (const key of baseKeys) {
    if (nextSet.has(key)) {
      diffValue([...path, key], base[key]!, next[key]!, ops, options);
    }
  }
}

function diffArray(
  path: string[],
  base: JsonValue[],
  next: JsonValue[],
  ops: JsonPatchOp[],
  lcsMaxCells?: number,
): boolean {
  const baseLength = base.length;
  const nextLength = next.length;
  let prefix = 0;

  while (prefix < baseLength && prefix < nextLength && jsonEquals(base[prefix]!, next[prefix]!)) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < baseLength - prefix &&
    suffix < nextLength - prefix &&
    jsonEquals(base[baseLength - 1 - suffix]!, next[nextLength - 1 - suffix]!)
  ) {
    suffix += 1;
  }

  const baseStart = prefix;
  const nextStart = prefix;
  const n = baseLength - prefix - suffix;
  const m = nextLength - prefix - suffix;

  if (!shouldUseLcsDiff(n, m, lcsMaxCells)) {
    return false;
  }

  if (n === 0 && m === 0) {
    return true;
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (jsonEquals(base[baseStart + i]!, next[nextStart + j]!)) {
        lcs[i]![j] = 1 + lcs[i + 1]![j + 1]!;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
  }

  const localOps: JsonPatchOp[] = [];
  let i = 0;
  let j = 0;
  let index = prefix;

  while (i < n || j < m) {
    if (i < n && j < m && jsonEquals(base[baseStart + i]!, next[nextStart + j]!)) {
      i += 1;
      j += 1;
      index += 1;
      continue;
    }

    const lcsDown = i < n ? lcs[i + 1]![j]! : -1;
    const lcsRight = j < m ? lcs[i]![j + 1]! : -1;

    if (j < m && (i === n || lcsRight > lcsDown)) {
      localOps.push({
        op: "add",
        path: stringifyJsonPointer([...path, String(index)]),
        value: next[nextStart + j]!,
      });
      j += 1;
      index += 1;
      continue;
    }

    if (i < n) {
      localOps.push({
        op: "remove",
        path: stringifyJsonPointer([...path, String(index)]),
      });
      i += 1;
      continue;
    }
  }

  ops.push(...compactArrayOps(localOps));
  return true;
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

function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Deep equality check for JSON values (null-safe, handles arrays and objects). */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {
    return true;
  }

  if (a === null || b === null) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i]!, b[i]!)) {
        return false;
      }
    }

    return true;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!hasOwn(b, key)) {
      return false;
    }
    if (!jsonEquals(a[key]!, b[key]!)) {
      return false;
    }
  }

  return true;
}

function isPlainObject(value: unknown): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ARRAY_INDEX_TOKEN_PATTERN = /^(0|[1-9][0-9]*)$/;

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
