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

/** Synchronous operation invoked once per tick, in phase then registration order. */
export type TickSystem = (context: TickContext) => void;

export type WorldStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'failed'; readonly tick: number; readonly systemName: string };

export interface World {
  /** Independent read-only snapshot of the current world state. */
  getState(): WorldSnapshot;
  /** Current tick-processing status. On failure, earlier systems may already have mutated state; no rollback is attempted. */
  getStatus(): WorldStatus;
  /** Register a uniquely named system for subsequent ticks; phase defaults to 0. */
  registerTickSystem(name: string, system: TickSystem, phase?: number): void;
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
  let failed: Extract<WorldStatus, { state: 'failed' }> | undefined;
  let advancing = false;
  const systems = new Map<string, { system: TickSystem; phase: number; order: number }>();
  let nextSystemOrder = 0;
  const snapshot = (): WorldSnapshot => ({ worldId, tick });
  const advance = (ticks: number): WorldSnapshot => {
    if (failed) {
      throw new Error(
        `world is in failed tick state at tick ${failed.tick} (system: ${failed.systemName})`,
      );
    }
    if (advancing) {
      throw new Error('reentrant world advancement is not allowed');
    }
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
    advancing = true;
    try {
      for (let i = 0; i < ticks; i++) {
        tick++;
        const context: TickContext = { worldId, tick };
        // Freeze this tick's system list; registrations during a tick start next tick.
        const tickSystems = [...systems.entries()].sort(
          ([, a], [, b]) => a.phase - b.phase || a.order - b.order,
        );
        for (const [name, { system }] of tickSystems) {
          try {
            const result: unknown = system(context);
            if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
              if (typeof (result as { then?: unknown }).then === 'function') {
                // Consume async failures to avoid an unhandled rejection. Async side effects
                // may continue after this failure and cannot be rolled back.
                void Promise.resolve(result).catch(() => undefined);
                throw new Error(
                  'tick systems must be synchronous; asynchronous side effects cannot be rolled back',
                );
              }
            }
          } catch (error) {
            // Systems may have mutated external state; the world cannot roll it back.
            failed = { state: 'failed', tick, systemName: name };
            throw error;
          }
        }
      }
      return snapshot();
    } finally {
      advancing = false;
    }
  };
  return {
    getState: snapshot,
    getStatus: () => (failed ? { ...failed } : { state: 'ready' }),
    registerTickSystem: (name, system, phase = 0) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new RangeError('tick system name must be a nonempty string');
      }
      if (systems.has(name)) {
        throw new Error(`tick system already registered: ${name}`);
      }
      if (typeof system !== 'function') {
        throw new TypeError('tick system must be a function');
      }
      if (!Number.isSafeInteger(phase)) {
        throw new TypeError('tick system phase must be a safe integer');
      }
      systems.set(name, { system, phase, order: nextSystemOrder++ });
    },
    step: () => advance(1),
    run: advance,
  };
}
