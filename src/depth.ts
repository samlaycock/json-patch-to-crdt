import type { ApplyError } from "./types";

export const MAX_TRAVERSAL_DEPTH = 16_384;

export class TraversalDepthError extends Error {
  readonly code = 409 as const;
  readonly reason = "MAX_DEPTH_EXCEEDED" as const;
  readonly depth: number;
  readonly maxDepth: number;

  constructor(depth: number, maxDepth: number = MAX_TRAVERSAL_DEPTH) {
    super(`maximum nesting depth ${maxDepth} exceeded at depth ${depth}`);
    this.name = "TraversalDepthError";
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

export function assertTraversalDepth(depth: number, maxDepth: number = MAX_TRAVERSAL_DEPTH): void {
  if (depth > maxDepth) {
    throw new TraversalDepthError(depth, maxDepth);
  }
}

export function toDepthApplyError(error: TraversalDepthError): ApplyError {
  return {
    ok: false,
    code: error.code,
    reason: error.reason,
    message: error.message,
  };
}
