/**
 * Minimal in-memory world with deterministic synchronous tick systems.
 * No wall clock, I/O, or dependencies are involved.
 */
export interface WorldSnapshot {
  readonly worldId: string;
  readonly tick: number;
}

export interface TickContext {
  readonly worldId: string;
  /** The one-based tick currently being processed. */
  readonly tick: number;
}

/** Synchronous operation invoked once per tick, in registration order. */
export type TickSystem = (context: TickContext) => void;

export interface World {
  /** Independent read-only snapshot of the current world state. */
  getState(): WorldSnapshot;
  /** Register a uniquely named system; it runs on subsequent ticks. */
  registerTickSystem(name: string, system: TickSystem): void;
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
  const systems = new Map<string, TickSystem>();
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
    if (systems.size === 0) {
      tick += ticks;
      return snapshot();
    }
    for (let i = 0; i < ticks; i++) {
      tick++;
      const context: TickContext = { worldId, tick };
      // Freeze this tick's system list; registrations during a tick start next tick.
      for (const system of [...systems.values()]) {
        system(context);
      }
    }
    return snapshot();
  };
  return {
    getState: snapshot,
    registerTickSystem: (name, system) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new RangeError('tick system name must be a nonempty string');
      }
      if (systems.has(name)) {
        throw new Error(`tick system already registered: ${name}`);
      }
      if (typeof system !== 'function') {
        throw new TypeError('tick system must be a function');
      }
      systems.set(name, system);
    },
    step: () => advance(1),
    run: advance,
  };
}
