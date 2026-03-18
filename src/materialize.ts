import type { JsonValue, Node, ObjEntry } from "./types";

import { assertTraversalDepth } from "./depth";
import { rgaCreateLinearCursor } from "./rga";

type MaterializeObserver = (path: readonly string[], node: Node) => void;

let materializeObserver: MaterializeObserver | null = null;

export function setMaterializeObserverForTests(observer: MaterializeObserver | null): void {
  materializeObserver = observer;
}

function createMaterializedObject(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

function setMaterializedProperty(
  out: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(out, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Convert a CRDT node graph into a plain JSON value using an explicit stack. */
export function materialize(node: Node): JsonValue {
  const observer = materializeObserver;
  observer?.([], node);

  if (node.kind === "lww") {
    return node.value;
  }

  const root: JsonValue = node.kind === "obj" ? createMaterializedObject() : [];
  type ObjFrame = {
    kind: "obj";
    depth: number;
    entries: IterableIterator<[string, ObjEntry]>;
    out: Record<string, JsonValue>;
    path: readonly string[];
  };
  type SeqFrame = {
    kind: "seq";
    depth: number;
    cursor: ReturnType<typeof rgaCreateLinearCursor>;
    out: JsonValue[];
    path: readonly string[];
    nextIndex: number;
  };
  type Frame = ObjFrame | SeqFrame;

  const stack: Frame[] = [];
  if (node.kind === "obj") {
    stack.push({
      kind: "obj",
      depth: 0,
      entries: node.entries.entries(),
      out: root as Record<string, JsonValue>,
      path: [],
    });
  } else {
    stack.push({
      kind: "seq",
      depth: 0,
      cursor: rgaCreateLinearCursor(node),
      out: root as JsonValue[],
      path: [],
      nextIndex: 0,
    });
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "obj") {
      const nextEntry = frame.entries.next();
      if (nextEntry.done) {
        stack.pop();
        continue;
      }

      const [key, entry] = nextEntry.value;
      const child = entry.node;
      const childDepth = frame.depth + 1;
      assertTraversalDepth(childDepth);
      const childPath = [...frame.path, key];
      observer?.(childPath, child);

      if (child.kind === "lww") {
        setMaterializedProperty(frame.out, key, child.value);
        continue;
      }

      if (child.kind === "obj") {
        const outObj = createMaterializedObject();
        setMaterializedProperty(frame.out, key, outObj);
        stack.push({
          kind: "obj",
          depth: childDepth,
          entries: child.entries.entries(),
          out: outObj,
          path: childPath,
        });
        continue;
      }

      const outArr: JsonValue[] = [];
      setMaterializedProperty(frame.out, key, outArr);
      stack.push({
        kind: "seq",
        depth: childDepth,
        cursor: rgaCreateLinearCursor(child),
        out: outArr,
        path: childPath,
        nextIndex: 0,
      });
      continue;
    }

    const elem = frame.cursor.next();
    if (!elem) {
      stack.pop();
      continue;
    }

    const child = elem.value;
    const childDepth = frame.depth + 1;
    assertTraversalDepth(childDepth);
    const childPath = [...frame.path, String(frame.nextIndex)];
    frame.nextIndex += 1;
    observer?.(childPath, child);

    if (child.kind === "lww") {
      frame.out.push(child.value);
      continue;
    }

    if (child.kind === "obj") {
      const outObj = createMaterializedObject();
      frame.out.push(outObj);
      stack.push({
        kind: "obj",
        depth: childDepth,
        entries: child.entries.entries(),
        out: outObj,
        path: childPath,
      });
      continue;
    }

    const outArr: JsonValue[] = [];
    frame.out.push(outArr);
    stack.push({
      kind: "seq",
      depth: childDepth,
      cursor: rgaCreateLinearCursor(child),
      out: outArr,
      path: childPath,
      nextIndex: 0,
    });
  }

  return root;
}
