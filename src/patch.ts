import { ROOT_KEY } from "./types";
import type {
  CompilePatchOptions,
  DiffOptions,
  IntentOp,
  JsonPatchOp,
  JsonValue,
  PatchErrorReason,
} from "./types";

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

  return ptr
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Convert a path array back to an RFC 6901 JSON Pointer string. */
export function stringifyJsonPointer(path: string[]): string {
  if (path.length === 0) {
    return "";
  }

  return `/${path.map(escapeJsonPointer).join("/")}`;
}

/**
 * Navigate a JSON value by path and return the value at that location.
 * Throws if the path is invalid, out of bounds, or traverses a non-container.
 */
export function getAtJson(base: JsonValue, path: string[]): JsonValue {
  let cur: any = base;

  for (const seg of path) {
    if (Array.isArray(cur)) {
      const idx = seg === "-" ? cur.length : Number(seg);

      if (!Number.isInteger(idx)) {
        throw new Error(`Expected array index, got ${seg}`);
      }

      if (idx < 0 || idx >= cur.length) {
        throw new Error(`Index out of bounds at ${seg}`);
      }

      cur = cur[idx];
    } else if (cur && typeof cur === "object") {
      if (!(seg in cur)) {
        throw new Error(`Missing key ${seg}`);
      }

      cur = cur[seg];
    } else {
      throw new Error(`Cannot traverse into non-container at ${seg}`);
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
  let workingBase: JsonValue = semantics === "sequential" ? structuredClone(baseJson) : baseJson;
  const intents: IntentOp[] = [];

  for (let opIndex = 0; opIndex < patch.length; opIndex++) {
    const op = patch[opIndex]!;
    const compileBase = semantics === "sequential" ? workingBase : baseJson;
    intents.push(...compileSingleOp(compileBase, op, opIndex, semantics));

    if (semantics === "sequential") {
      workingBase = applyPatchOpToJson(workingBase, op, opIndex);
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
  const ops: JsonPatchOp[] = [];
  diffValue([], base, next, ops, options);
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
      diffArray(path, base, next, ops, options);
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
  _options: DiffOptions,
): void {
  const n = base.length;
  const m = next.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (jsonEquals(base[i]!, next[j]!)) {
        lcs[i]![j] = 1 + lcs[i + 1]![j + 1]!;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
  }

  const localOps: JsonPatchOp[] = [];
  let i = 0;
  let j = 0;
  let index = 0;

  while (i < n || j < m) {
    if (i < n && j < m && jsonEquals(base[i]!, next[j]!)) {
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
        value: next[j]!,
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
    if (!(key in b)) {
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

function hasOwn(value: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
): IntentOp[] {
  if (op.op === "test") {
    return [
      {
        t: "Test",
        path: parsePointerOrThrow(op.path, op.path, opIndex),
        value: op.value,
      },
    ];
  }

  if (op.op === "copy" || op.op === "move") {
    const fromPath = parsePointerOrThrow(op.from, op.from, opIndex);
    const toPath = parsePointerOrThrow(op.path, op.path, opIndex);

    if (op.op === "move" && isStrictDescendantPath(fromPath, toPath)) {
      throw compileError(
        "INVALID_MOVE",
        `cannot move a value into one of its descendants at ${op.path}`,
        op.path,
        opIndex,
      );
    }

    const val = lookupValueOrThrow(baseJson, fromPath, op.from, opIndex);

    if (op.op === "move" && isSamePath(fromPath, toPath)) {
      return [];
    }

    if (op.op === "move" && semantics === "sequential") {
      const removeOp: JsonPatchOp = { op: "remove", path: op.from };
      const addOp: JsonPatchOp = { op: "add", path: op.path, value: val };
      const baseAfterRemove = applyPatchOpToJson(baseJson, removeOp, opIndex);

      return [
        ...compileSingleOp(baseJson, removeOp, opIndex, semantics),
        ...compileSingleOp(baseAfterRemove, addOp, opIndex, semantics),
      ];
    }

    const out = compileSingleOp(
      baseJson,
      { op: "add", path: op.path, value: val },
      opIndex,
      semantics,
    );

    if (op.op === "move") {
      out.push(...compileSingleOp(baseJson, { op: "remove", path: op.from }, opIndex, semantics));
    }

    return out;
  }

  const path = parsePointerOrThrow(op.path, op.path, opIndex);

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

function applyPatchOpToJson(baseJson: JsonValue, op: JsonPatchOp, opIndex: number): JsonValue {
  let doc = structuredClone(baseJson) as JsonValue;

  if (op.op === "test") {
    return doc;
  }

  if (op.op === "copy" || op.op === "move") {
    const fromPath = parsePointerOrThrow(op.from, op.from, opIndex);
    const value = structuredClone(lookupValueOrThrow(doc, fromPath, op.from, opIndex));
    if (op.op === "move") {
      doc = applyPatchOpToJson(doc, { op: "remove", path: op.from }, opIndex);
    }
    return applyPatchOpToJson(doc, { op: "add", path: op.path, value }, opIndex);
  }

  const path = parsePointerOrThrow(op.path, op.path, opIndex);
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
  let parent: JsonValue;
  if (parentPath.length === 0) {
    parent = doc;
  } else {
    parent = lookupValueOrThrow(doc, parentPath, op.path, opIndex);
  }

  if (Array.isArray(parent)) {
    const index = parseArrayIndexToken(token, op.op, parent.length, op.path, opIndex);
    if (op.op === "add") {
      const insertAt = index === Number.POSITIVE_INFINITY ? parent.length : index;
      parent.splice(insertAt, 0, structuredClone(op.value));
      return doc;
    }

    if (op.op === "replace") {
      parent[index] = structuredClone(op.value);
      return doc;
    }

    parent.splice(index, 1);
    return doc;
  }

  if (!isPlainObject(parent)) {
    throw compileError(
      "INVALID_TARGET",
      `expected object or array parent at ${stringifyJsonPointer(parentPath)}`,
      op.path,
      opIndex,
    );
  }

  if (op.op === "add" || op.op === "replace") {
    parent[token] = structuredClone(op.value);
    return doc;
  }

  delete parent[token];
  return doc;
}

function parsePointerOrThrow(ptr: string, path: string, opIndex: number): string[] {
  try {
    return parseJsonPointer(ptr);
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

  if (!/^[0-9]+$/.test(token)) {
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
  const message = error instanceof Error ? error.message : "invalid path";

  if (message.includes("Expected array index")) {
    return compileError("INVALID_POINTER", message, path, opIndex);
  }

  if (message.includes("Index out of bounds")) {
    return compileError("OUT_OF_BOUNDS", message, path, opIndex);
  }

  if (message.includes("Missing key")) {
    return compileError("MISSING_PARENT", message, path, opIndex);
  }

  if (message.includes("Cannot traverse into non-container")) {
    return compileError("INVALID_TARGET", message, path, opIndex);
  }

  return compileError("INVALID_PATCH", message, path, opIndex);
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
