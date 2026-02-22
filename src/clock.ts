import type { ActorId, Clock, Dot, VersionVector } from "./types";

export type ClockValidationErrorReason = "INVALID_ACTOR" | "INVALID_COUNTER";

export class ClockValidationError extends TypeError {
  readonly reason: ClockValidationErrorReason;

  constructor(reason: ClockValidationErrorReason, message: string) {
    super(message);
    this.name = "ClockValidationError";
    this.reason = reason;
  }
}

function readVvCounter(vv: VersionVector, actor: ActorId): number {
  if (!Object.prototype.hasOwnProperty.call(vv, actor)) {
    return 0;
  }

  const counter = vv[actor];
  return typeof counter === "number" ? counter : 0;
}

function writeVvCounter(vv: VersionVector, actor: ActorId, counter: number): void {
  Object.defineProperty(vv, actor, {
    configurable: true,
    enumerable: true,
    value: counter,
    writable: true,
  });
}

/**
 * Create a new clock for the given actor. Each call to `clock.next()` yields a fresh `Dot`.
 * @param actor - Unique identifier for this peer.
 * @param start - Initial counter value (defaults to 0).
 */
export function createClock(actor: ActorId, start = 0): Clock {
  assertActorId(actor);
  assertCounter(start);

  const clock: Clock = {
    actor,
    ctr: start,
    next() {
      clock.ctr += 1;
      const dot: Dot = { actor: clock.actor, ctr: clock.ctr };
      return dot;
    },
  };

  return clock;
}

function assertActorId(actor: ActorId): void {
  if (actor.length === 0) {
    throw new ClockValidationError("INVALID_ACTOR", "actor must not be empty");
  }
}

function assertCounter(counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new ClockValidationError(
      "INVALID_COUNTER",
      "counter must be a non-negative safe integer",
    );
  }
}

/** Create an independent copy of a clock at the same counter position. */
export function cloneClock(clock: Clock): Clock {
  return createClock(clock.actor, clock.ctr);
}

/**
 * Generate the next per-actor dot from a mutable version vector.
 * Useful when a server needs to mint dots for many actors.
 */
export function nextDotForActor(vv: VersionVector, actor: ActorId): Dot {
  const ctr = readVvCounter(vv, actor) + 1;
  writeVvCounter(vv, actor, ctr);
  return { actor, ctr };
}

/** Record an observed dot in a version vector. */
export function observeDot(vv: VersionVector, dot: Dot): void {
  if (readVvCounter(vv, dot.actor) < dot.ctr) {
    writeVvCounter(vv, dot.actor, dot.ctr);
  }
}
