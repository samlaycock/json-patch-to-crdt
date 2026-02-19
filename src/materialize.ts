import type { JsonValue, Node } from "./types";

import { assertTraversalDepth } from "./depth";
import { rgaLinearizeIds } from "./rga";

/** Convert a CRDT node graph into a plain JSON value using an explicit stack. */
export function materialize(node: Node): JsonValue {
  if (node.kind === "lww") {
    return node.value;
  }

  const root: JsonValue = node.kind === "obj" ? {} : [];
  type ObjFrame = {
    kind: "obj";
    depth: number;
    entries: Array<[string, Node]>;
    index: number;
    out: Record<string, JsonValue>;
  };
  type SeqFrame = {
    kind: "seq";
    depth: number;
    ids: string[];
    index: number;
    seq: Extract<Node, { kind: "seq" }>;
    out: JsonValue[];
  };
  type Frame = ObjFrame | SeqFrame;

  const stack: Frame[] = [];
  if (node.kind === "obj") {
    stack.push({
      kind: "obj",
      depth: 0,
      entries: Array.from(node.entries.entries(), ([key, value]) => [key, value.node]),
      index: 0,
      out: root as Record<string, JsonValue>,
    });
  } else {
    stack.push({
      kind: "seq",
      depth: 0,
      ids: rgaLinearizeIds(node),
      index: 0,
      seq: node,
      out: root as JsonValue[],
    });
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "obj") {
      if (frame.index >= frame.entries.length) {
        stack.pop();
        continue;
      }

      const [key, child] = frame.entries[frame.index++]!;
      const childDepth = frame.depth + 1;
      assertTraversalDepth(childDepth);

      if (child.kind === "lww") {
        frame.out[key] = child.value;
        continue;
      }

      if (child.kind === "obj") {
        const outObj: Record<string, JsonValue> = {};
        frame.out[key] = outObj;
        stack.push({
          kind: "obj",
          depth: childDepth,
          entries: Array.from(child.entries.entries(), ([childKey, value]) => [
            childKey,
            value.node,
          ]),
          index: 0,
          out: outObj,
        });
        continue;
      }

      const outArr: JsonValue[] = [];
      frame.out[key] = outArr;
      stack.push({
        kind: "seq",
        depth: childDepth,
        ids: rgaLinearizeIds(child),
        index: 0,
        seq: child,
        out: outArr,
      });
      continue;
    }

    if (frame.index >= frame.ids.length) {
      stack.pop();
      continue;
    }

    const id = frame.ids[frame.index++]!;
    const child = frame.seq.elems.get(id)!.value;
    const childDepth = frame.depth + 1;
    assertTraversalDepth(childDepth);

    if (child.kind === "lww") {
      frame.out.push(child.value);
      continue;
    }

    if (child.kind === "obj") {
      const outObj: Record<string, JsonValue> = {};
      frame.out.push(outObj);
      stack.push({
        kind: "obj",
        depth: childDepth,
        entries: Array.from(child.entries.entries(), ([key, value]) => [key, value.node]),
        index: 0,
        out: outObj,
      });
      continue;
    }

    const outArr: JsonValue[] = [];
    frame.out.push(outArr);
    stack.push({
      kind: "seq",
      depth: childDepth,
      ids: rgaLinearizeIds(child),
      index: 0,
      seq: child,
      out: outArr,
    });
  }

  return root;
}
