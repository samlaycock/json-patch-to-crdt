import { ROOT_KEY } from "./types";
import type { DiffOptions, IntentOp, JsonPatchOp, JsonValue } from "./types";

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
export function compileJsonPatchToIntent(baseJson: JsonValue, patch: JsonPatchOp[]): IntentOp[] {
  const intents: IntentOp[] = [];

  for (const op of patch) {
    if (op.op === "test") {
      intents.push({
        t: "Test",
        path: parseJsonPointer(op.path),
        value: op.value,
      });

      continue;
    }

    if (op.op === "copy" || op.op === "move") {
      const fromPath = parseJsonPointer(op.from);
      const val = getAtJson(baseJson, fromPath);

      // copy/move becomes add + (optional) remove
      intents.push(
        ...compileJsonPatchToIntent(baseJson, [{ op: "add", path: op.path, value: val }]),
      );

      if (op.op === "move") {
        intents.push(...compileJsonPatchToIntent(baseJson, [{ op: "remove", path: op.from }]));
      }

      continue;
    }

    const path = parseJsonPointer(op.path);
    const parent = path.slice(0, -1);
    const last = path[path.length - 1];

    // Root replacement: treat as atomic set
    if (path.length === 0) {
      if (op.op === "replace" || op.op === "add") {
        intents.push({ t: "ObjSet", path: [], key: ROOT_KEY, value: op.value });
      } else if (op.op === "remove") {
        // root remove -> set null (or reject). We'll set null.
        intents.push({ t: "ObjSet", path: [], key: ROOT_KEY, value: null });
      }

      continue;
    }

    const isIndexLike = (s: string) => s === "-" || /^[0-9]+$/.test(s);

    // If last segment is array index, compile as array intent
    if (isIndexLike(last!)) {
      const index = last === "-" ? Number.POSITIVE_INFINITY : Number(last);

      if (op.op === "add") {
        intents.push({ t: "ArrInsert", path: parent, index, value: op.value });
      } else if (op.op === "remove") {
        intents.push({ t: "ArrDelete", path: parent, index });
      } else if (op.op === "replace") {
        intents.push({ t: "ArrReplace", path: parent, index, value: op.value });
      } else {
        assertNever(op, "Unsupported op at array index path");
      }
    } else {
      const parentValue = pathValueAt(baseJson, parent);
      if (!isPlainObject(parentValue)) {
        throw new Error(`Expected object parent at ${stringifyJsonPointer(parent)}`);
      }

      if ((op.op === "replace" || op.op === "remove") && !hasOwn(parentValue, last!)) {
        throw new Error(`Missing key ${last} at ${stringifyJsonPointer(parent)}`);
      }

      // Object key
      if (op.op === "add") {
        intents.push({
          t: "ObjSet",
          path: parent,
          key: last!,
          value: op.value,
          mode: "add",
        });
      } else if (op.op === "replace") {
        intents.push({
          t: "ObjSet",
          path: parent,
          key: last!,
          value: op.value,
          mode: "replace",
        });
      } else if (op.op === "remove") {
        intents.push({ t: "ObjRemove", path: parent, key: last! });
      } else {
        assertNever(op, "Unsupported op");
      }
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

function isPlainObject(value: JsonValue): value is { [k: string]: JsonValue } {
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
