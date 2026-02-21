import type { JsonValidationMode, JsonValue } from "./types";

import { assertTraversalDepth } from "./depth";

type ValidationFrame = {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
};

type NormalizeSlot =
  | { readonly kind: "root" }
  | { readonly kind: "array"; readonly out: JsonValue[]; readonly index: number }
  | { readonly kind: "object"; readonly out: Record<string, JsonValue>; readonly key: string };

type NormalizeFrame = {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
  readonly slot: NormalizeSlot;
};

/**
 * Runtime validation error for values that are not JSON-compatible.
 * `path` is an RFC 6901 pointer relative to the validated root.
 */
export class JsonValueValidationError extends TypeError {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    const target = path === "" ? "<root>" : path;
    super(`invalid JSON value at ${target}: ${detail}`);
    this.name = "JsonValueValidationError";
    this.path = path;
    this.detail = detail;
  }
}

/** Assert that a runtime value is JSON-compatible (including finite numbers only). */
export function assertRuntimeJsonValue(value: unknown): asserts value is JsonValue {
  const stack: ValidationFrame[] = [{ value, path: "", depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (isJsonPrimitive(frame.value)) {
      continue;
    }

    if (Array.isArray(frame.value)) {
      for (const [index, child] of frame.value.entries()) {
        stack.push({
          value: child,
          path: appendPointerSegment(frame.path, String(index)),
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    if (isJsonObject(frame.value)) {
      for (const [key, child] of Object.entries(frame.value)) {
        stack.push({
          value: child,
          path: appendPointerSegment(frame.path, key),
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    throw new JsonValueValidationError(frame.path, describeInvalidValue(frame.value));
  }
}

/**
 * Normalize a runtime value to JSON-compatible data.
 * - non-finite numbers -> null
 * - invalid object-property values -> key omitted
 * - invalid root / array values -> null
 */
export function normalizeRuntimeJsonValue(value: unknown): JsonValue {
  const rootHolder: { value?: JsonValue } = {};
  const stack: NormalizeFrame[] = [{ value, path: "", depth: 0, slot: { kind: "root" } }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    assertTraversalDepth(frame.depth);

    if (isJsonPrimitive(frame.value)) {
      assignSlot(frame.slot, frame.value, rootHolder);
      continue;
    }

    if (Array.isArray(frame.value)) {
      const out: JsonValue[] = [];
      assignSlot(frame.slot, out, rootHolder);

      for (const [index, child] of frame.value.entries()) {
        stack.push({
          value: child,
          path: appendPointerSegment(frame.path, String(index)),
          depth: frame.depth + 1,
          slot: { kind: "array", out, index },
        });
      }
      continue;
    }

    if (isJsonObject(frame.value)) {
      const out = Object.create(null) as Record<string, JsonValue>;
      assignSlot(frame.slot, out, rootHolder);

      for (const [key, child] of Object.entries(frame.value)) {
        stack.push({
          value: child,
          path: appendPointerSegment(frame.path, key),
          depth: frame.depth + 1,
          slot: { kind: "object", out, key },
        });
      }
      continue;
    }

    if (isNonFiniteNumber(frame.value)) {
      assignSlot(frame.slot, null, rootHolder);
      continue;
    }

    if (frame.slot.kind !== "object") {
      assignSlot(frame.slot, null, rootHolder);
    }
  }

  return rootHolder.value ?? null;
}

/** Runtime JSON guardrail helper shared by create/apply/diff paths. */
export function coerceRuntimeJsonValue(value: unknown, mode: JsonValidationMode): JsonValue {
  if (mode === "none") {
    return value as JsonValue;
  }

  if (mode === "strict") {
    assertRuntimeJsonValue(value);
    return value;
  }

  return normalizeRuntimeJsonValue(value);
}

function assignSlot(
  slot: NormalizeSlot,
  value: JsonValue,
  rootHolder: { value?: JsonValue },
): void {
  if (slot.kind === "root") {
    rootHolder.value = value;
    return;
  }

  if (slot.kind === "array") {
    slot.out[slot.index] = value;
    return;
  }

  slot.out[slot.key] = value;
}

function appendPointerSegment(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  if (path === "") {
    return `/${escaped}`;
  }

  return `${path}/${escaped}`;
}

function isJsonPrimitive(value: unknown): value is null | string | number | boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  return typeof value === "number" && Number.isFinite(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isFinite(value);
}

function describeInvalidValue(value: unknown): string {
  if (typeof value === "number") {
    return `non-finite number (${String(value)})`;
  }

  if (value === undefined) {
    return "undefined is not valid JSON";
  }

  if (typeof value === "bigint") {
    return "bigint is not valid JSON";
  }

  if (typeof value === "symbol") {
    return "symbol is not valid JSON";
  }

  if (typeof value === "function") {
    return "function is not valid JSON";
  }

  return `unsupported value type (${typeof value})`;
}
