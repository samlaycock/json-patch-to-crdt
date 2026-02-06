import type { ActorId, Clock, Dot, VersionVector } from "./types";

/**
 * Create a new clock for the given actor. Each call to `clock.next()` yields a fresh `Dot`.
 * @param actor - Unique identifier for this peer.
 * @param start - Initial counter value (defaults to 0).
 */
export function createClock(actor: ActorId, start = 0): Clock {
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

/** Create an independent copy of a clock at the same counter position. */
export function cloneClock(clock: Clock): Clock {
  return createClock(clock.actor, clock.ctr);
}

/**
 * Generate the next per-actor dot from a mutable version vector.
 * Useful when a server needs to mint dots for many actors.
 */
export function nextDotForActor(vv: VersionVector, actor: ActorId): Dot {
  const ctr = (vv[actor] ?? 0) + 1;
  vv[actor] = ctr;
  return { actor, ctr };
}

/** Record an observed dot in a version vector. */
export function observeDot(vv: VersionVector, dot: Dot): void {
  if ((vv[dot.actor] ?? 0) < dot.ctr) {
    vv[dot.actor] = dot.ctr;
  }
}
