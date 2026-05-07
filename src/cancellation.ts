import type { ApplyError, DeserializeFailure } from "./types";

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export class OperationCancelledError extends Error {
  readonly reasonValue?: unknown;

  constructor(reason?: unknown) {
    super(toCancellationMessage(reason));
    this.name = "OperationCancelledError";
    this.reasonValue = reason;
  }
}

export function throwIfAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted) {
    throw new OperationCancelledError(signal.reason);
  }
}

export function toCancellationApplyError(error: OperationCancelledError): ApplyError {
  return {
    ok: false,
    code: 409,
    reason: "OPERATION_CANCELLED",
    message: error.message,
  };
}

export function toCancellationDeserializeFailure(
  error: OperationCancelledError,
): DeserializeFailure {
  return {
    code: 409,
    reason: "OPERATION_CANCELLED",
    message: error.message,
  };
}

function toCancellationMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) {
    return `operation cancelled: ${reason.message}`;
  }

  if (typeof reason === "string" && reason.length > 0) {
    return `operation cancelled: ${reason}`;
  }

  return "operation cancelled";
}
