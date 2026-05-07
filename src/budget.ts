import type {
  ApplyError,
  DeserializeFailure,
  ResourceBudget,
  ResourceBudgetExceededFailure,
  ResourceBudgetKind,
} from "./types";

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatPath(path?: string): string {
  if (path === undefined || path === "") {
    return "";
  }

  return ` at ${path}`;
}

function formatOpIndex(opIndex?: number): string {
  if (opIndex === undefined) {
    return "";
  }

  return ` at op ${opIndex}`;
}

export class ResourceBudgetError extends Error {
  readonly reason = "RESOURCE_BUDGET_EXCEEDED" as const;
  readonly code = 409 as const;
  readonly budget: ResourceBudgetKind;
  readonly limit: number;
  readonly actual: number;
  readonly path?: string;
  readonly opIndex?: number;

  constructor(
    budget: ResourceBudgetKind,
    limit: number,
    actual: number,
    path?: string,
    opIndex?: number,
  ) {
    super(
      `resource budget '${budget}' exceeded${formatPath(path)}${formatOpIndex(opIndex)}: ${actual} > ${limit}`,
    );
    this.name = "ResourceBudgetError";
    this.budget = budget;
    this.limit = limit;
    this.actual = actual;
    this.path = path;
    this.opIndex = opIndex;
  }
}

export class ResourceBudgetMeter {
  readonly #budget: ResourceBudget;
  readonly #counts: Record<ResourceBudgetKind, number>;

  constructor(budget?: ResourceBudget) {
    this.#budget = validateBudget(budget);
    this.#counts = {
      patchOperations: 0,
      objectEntries: 0,
      sequenceElements: 0,
      visitedNodes: 0,
      serializedElements: 0,
      arrayDiffCells: 0,
    };
  }

  count(kind: ResourceBudgetKind, delta: number, path?: string, opIndex?: number): void {
    if (delta <= 0) {
      return;
    }

    this.#counts[kind] += delta;
    const limit = this.#budget[kind];
    if (limit !== undefined && this.#counts[kind] > limit) {
      throw new ResourceBudgetError(kind, limit, this.#counts[kind], path, opIndex);
    }
  }
}

export function createBudgetMeter(budget?: ResourceBudget): ResourceBudgetMeter | undefined {
  if (budget === undefined) {
    return undefined;
  }

  return new ResourceBudgetMeter(budget);
}

export function toBudgetApplyError(error: ResourceBudgetError): ApplyError {
  return {
    ok: false,
    code: error.code,
    reason: error.reason,
    message: error.message,
    budget: error.budget,
    limit: error.limit,
    actual: error.actual,
    path: error.path,
    opIndex: error.opIndex,
  };
}

export function toBudgetDeserializeFailure(
  error: ResourceBudgetError,
): ResourceBudgetExceededFailure | DeserializeFailure {
  return {
    code: error.code,
    reason: error.reason,
    message: error.message,
    budget: error.budget,
    limit: error.limit,
    actual: error.actual,
    path: error.path,
  };
}

function validateBudget(budget: ResourceBudget | undefined): ResourceBudget {
  if (budget === undefined) {
    return {};
  }

  const normalized: ResourceBudget = {};
  const entries = Object.entries(budget) as Array<[ResourceBudgetKind, number | undefined]>;

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }

    if (!isNonNegativeSafeInteger(value)) {
      throw new Error(`resource budget '${key}' must be a non-negative safe integer`);
    }

    normalized[key] = value;
  }

  return normalized;
}
