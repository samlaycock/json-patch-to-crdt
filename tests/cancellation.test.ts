import { describe, expect, it } from "bun:test";

import {
  createState,
  deserializeState,
  diffJsonPatch,
  mergeState,
  OperationCancelledError,
  serializeState,
  tryApplyPatch,
  tryDeserializeState,
  tryMergeState,
  type JsonValue,
} from "../src/index";

function abortedSignal(reason = "deadline exceeded"): AbortSignal {
  return AbortSignal.abort(reason);
}

function makeLargeObject(size: number): Record<string, JsonValue> {
  const value: Record<string, JsonValue> = {};
  for (let index = 0; index < size; index++) {
    value[`key${index}`] = index;
  }
  return value;
}

describe("operation cancellation", () => {
  it("cancels JSON Patch diff work", () => {
    expect(() =>
      diffJsonPatch(makeLargeObject(100), makeLargeObject(100), {
        signal: abortedSignal(),
      }),
    ).toThrow(OperationCancelledError);
  });

  it("returns a typed cancellation failure from patch application", () => {
    const state = createState({ count: 0 }, { actor: "A" });
    const result = tryApplyPatch(state, [{ op: "replace", path: "/count", value: 1 }], {
      signal: abortedSignal("request closed"),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        ok: false,
        code: 409,
        reason: "OPERATION_CANCELLED",
        message: "operation cancelled: request closed",
      },
    });
  });

  it("returns a typed cancellation failure from merge", () => {
    const a = createState({ left: makeLargeObject(100) }, { actor: "A" });
    const b = createState({ right: makeLargeObject(100) }, { actor: "B" });
    const result = tryMergeState(a, b, { signal: abortedSignal() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("OPERATION_CANCELLED");
    }
  });

  it("throws a merge error for cancelled throwing merges", () => {
    const a = createState({ a: 1 }, { actor: "A" });
    const b = createState({ b: 2 }, { actor: "B" });

    expect(() => mergeState(a, b, { signal: abortedSignal() })).toThrow("operation cancelled");
  });

  it("returns a typed cancellation failure from deserialization", () => {
    const state = createState(makeLargeObject(100), { actor: "A" });
    const serialized = serializeState(state);
    const result = tryDeserializeState(serialized, { signal: abortedSignal() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("OPERATION_CANCELLED");
    }
  });

  it("throws a deserialize error for cancelled throwing deserialization", () => {
    const state = createState({ a: 1 }, { actor: "A" });
    const serialized = serializeState(state);

    expect(() => deserializeState(serialized, { signal: abortedSignal() })).toThrow(
      "operation cancelled",
    );
  });
});
