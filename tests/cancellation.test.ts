import { describe, expect, it } from "bun:test";

import {
  createState,
  DeserializeError,
  deserializeState,
  diffJsonPatch,
  mergeState,
  OperationCancelledError,
  serializeState,
  tryApplyPatch,
  tryApplyPatchInPlace,
  tryDeserializeState,
  tryMergeState,
  toJson,
  type JsonValue,
} from "../src/index";
import { crdtToJsonPatch, newReg, type RgaSeq } from "../src/internals";

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

function abortOnCheck(check: number, reason = "deadline exceeded"): AbortSignal {
  let checks = 0;
  return {
    get aborted() {
      checks += 1;
      return checks >= check;
    },
    reason,
  } as AbortSignal;
}

describe("operation cancellation", () => {
  it("cancels JSON Patch diff work", () => {
    expect(() =>
      diffJsonPatch(makeLargeObject(100), makeLargeObject(100), {
        signal: abortedSignal(),
      }),
    ).toThrow(OperationCancelledError);
  });

  it("cancels CRDT-native diff work before traversal", () => {
    const base = createState({ x: 1 }, { actor: "A" });
    const head = createState({ x: 2 }, { actor: "B" });

    expect(() =>
      crdtToJsonPatch(base.doc, head.doc, {
        signal: abortedSignal("stop"),
      }),
    ).toThrow(OperationCancelledError);
  });

  it("cancels CRDT-native object traversal", () => {
    const base = createState(makeLargeObject(100), { actor: "A" });
    const head = createState({ ...makeLargeObject(100), key99: -1 }, { actor: "B" });

    expect(() =>
      crdtToJsonPatch(base.doc, head.doc, {
        signal: abortOnCheck(5, "stop"),
      }),
    ).toThrow(OperationCancelledError);
  });

  it("cancels CRDT-native sequence traversal", () => {
    const base = createState(
      Array.from({ length: 100 }, (_, index) => index),
      { actor: "A" },
    );
    const head = createState(
      Array.from({ length: 100 }, (_, index) => index),
      { actor: "B" },
    );
    expect(head.doc.root.kind).toBe("seq");
    if (head.doc.root.kind !== "seq") {
      throw new Error("expected sequence root");
    }

    const items = head.doc.root as RgaSeq;
    Array.from(items.elems.values()).at(-1)!.value = newReg(-1, { actor: "C", ctr: 1 });

    expect(() =>
      crdtToJsonPatch(base.doc, head.doc, {
        signal: abortOnCheck(6, "stop"),
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

  it("preserves partial in-place changes when non-atomic patching is cancelled", () => {
    const state = createState({ count: 0, other: 0 }, { actor: "A" });
    const result = tryApplyPatchInPlace(
      state,
      [
        { op: "replace", path: "/count", value: 1 },
        { op: "replace", path: "/other", value: 2 },
      ],
      {
        atomic: false,
        signal: abortOnCheck(3, "request closed"),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        ok: false,
        code: 409,
        reason: "OPERATION_CANCELLED",
        message: "operation cancelled: request closed",
      },
    });
    expect(toJson(state)).toEqual({ count: 1, other: 0 });
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
      DeserializeError,
    );
  });
});
