import { rgaLinearizeIds } from "./rga";
import type { JsonValue, Node } from "./types";

/** Recursively convert a CRDT node graph into a plain JSON value. */
export function materialize(node: Node): JsonValue {
  switch (node.kind) {
    case "lww":
      return node.value;
    case "obj": {
      const out: Record<string, JsonValue> = {};

      for (const [k, { node: child }] of node.entries.entries()) {
        out[k] = materialize(child);
      }

      return out;
    }
    case "seq": {
      const ids = rgaLinearizeIds(node);

      return ids.map((id) => materialize(node.elems.get(id)!.value));
    }
  }
}
