import type { Dot, JsonValue, LwwReg, Node, ObjNode, RgaSeq } from "./types";

import { compareDot } from "./dot";

export function newObj(): ObjNode {
  return { kind: "obj", entries: new Map(), tombstone: new Map() };
}

export function newSeq(): RgaSeq {
  return { kind: "seq", elems: new Map() };
}

export function newReg(value: JsonValue, dot: Dot): LwwReg {
  return { kind: "lww", value, dot };
}

export function lwwSet(reg: LwwReg, value: JsonValue, dot: Dot): void {
  if (compareDot(reg.dot, dot) <= 0) {
    reg.value = value;
    reg.dot = dot;
  }
}

export function objSet(obj: ObjNode, key: string, node: Node, dot: Dot): void {
  const delDot = obj.tombstone.get(key);

  if (delDot && compareDot(delDot, dot) >= 0) {
    return; // delete-wins for this key
  }

  const cur = obj.entries.get(key);

  if (!cur || compareDot(cur.dot, dot) <= 0) {
    obj.entries.set(key, { node, dot });
  }
}

export function objRemove(obj: ObjNode, key: string, dot: Dot): void {
  const curDel = obj.tombstone.get(key);

  if (!curDel || compareDot(curDel, dot) <= 0) {
    obj.tombstone.set(key, dot);
  }

  // You can keep entry for history or drop it; dropping is fine with remove-wins.
  obj.entries.delete(key);
}
