import { rgaLinearizeIds } from "./rga";
import type { JsonValue, Node } from "./types";

const DEFAULT_MAX_DEPTH = 1024;

type Frame = {
  node: Node;
  depth: number;
  children: Node[];
  childIndex: number;
  result: JsonValue;
  phase: "process" | "collect";
};

export function materialize(node: Node, maxDepth: number = DEFAULT_MAX_DEPTH): JsonValue {
  const stack: Frame[] = [];
  const results: Map<Node, JsonValue> = new Map();

  stack.push({
    node,
    depth: 0,
    children: [],
    childIndex: 0,
    result: null as unknown as JsonValue,
    phase: "process",
  });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;

    if (frame.phase === "process") {
      if (frame.depth > maxDepth) {
        throw new Error(`Maximum nesting depth of ${maxDepth} exceeded`);
      }

      if (frame.node.kind === "lww") {
        results.set(frame.node, frame.node.value);
        stack.pop();
        continue;
      }

      if (frame.node.kind === "obj") {
        const children: Node[] = [];
        for (const [, { node: child }] of frame.node.entries.entries()) {
          children.push(child);
        }

        if (children.length === 0) {
          results.set(frame.node, {});
          stack.pop();
        } else {
          frame.children = children;
          frame.phase = "collect";
        }
        continue;
      }

      if (frame.node.kind === "seq") {
        const ids = rgaLinearizeIds(frame.node);
        const children: Node[] = [];
        for (const id of ids) {
          children.push(frame.node.elems.get(id)!.value);
        }

        if (children.length === 0) {
          results.set(frame.node, []);
          stack.pop();
        } else {
          frame.children = children;
          frame.phase = "collect";
        }
        continue;
      }
    }

    if (frame.phase === "collect") {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]!;
        frame.childIndex++;

        if (!results.has(child)) {
          stack.push({
            node: child,
            depth: frame.depth + 1,
            children: [],
            childIndex: 0,
            result: null as unknown as JsonValue,
            phase: "process",
          });
        }
        continue;
      }

      if (frame.node.kind === "obj") {
        const out: Record<string, JsonValue> = {};
        for (const [k, { node: child }] of frame.node.entries.entries()) {
          out[k] = results.get(child)!;
        }
        results.set(frame.node, out);
      } else if (frame.node.kind === "seq") {
        const ids = rgaLinearizeIds(frame.node);
        const arr: JsonValue[] = [];
        for (const id of ids) {
          const child = frame.node.elems.get(id)!.value;
          arr.push(results.get(child)!);
        }
        results.set(frame.node, arr);
      }

      stack.pop();
    }
  }

  return results.get(node)!;
}
