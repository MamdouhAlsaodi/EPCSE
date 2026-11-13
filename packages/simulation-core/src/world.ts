/**
 * Minimal in-memory world: a nonempty identity plus a virtual tick counter.
 * Deterministic and synchronous — no wall clock, no I/O, no dependencies.
 * This is not the full simulation engine; no domain rules exist yet.
 */
export interface WorldSnapshot {
  readonly worldId: string;
  readonly tick: number;
}

export interface World {
  /** Independent read-only snapshot of the current world state. */
  getState(): WorldSnapshot;
  /** Advance by exactly one tick. */
  step(): WorldSnapshot;
  /** Advance by exactly n ticks (0 accepted). */
  run(ticks: number): WorldSnapshot;
}

export function createWorld(worldId: string): World {
  if (typeof worldId !== 'string') {
    throw new TypeError('worldId must be a string');
  }
  if (worldId.length === 0) {
    throw new RangeError('worldId must be a nonempty string');
  }
  let tick = 0;
  const snapshot = (): WorldSnapshot => ({ worldId, tick });
  const advance = (ticks: number): WorldSnapshot => {
    // Number.isInteger rejects non-numbers, NaN and ±Infinity.
    if (!Number.isInteger(ticks)) {
      throw new TypeError(`ticks must be an integer, got ${ticks}`);
    }
    if (ticks < 0) {
      throw new RangeError(`ticks must be non-negative, got ${ticks}`);
    }
    // Guard before mutating; written this way so tick + ticks is never computed
    // outside the safe integer range.
    if (ticks > Number.MAX_SAFE_INTEGER - tick) {
      throw new RangeError(`advancing by ${ticks} ticks would exceed Number.MAX_SAFE_INTEGER`);
    }
    tick += ticks;
    return snapshot();
  };
  return {
    getState: snapshot,
    step: () => advance(1),
    run: advance,
  };
}
