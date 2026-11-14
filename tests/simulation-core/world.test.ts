import { describe, expect, it } from 'vitest';
import {
  COMMODITIES,
  createWorld,
  createWorldDomain,
  engineStatus,
  type Commodity,
} from '@epcse/simulation-core';

describe('world identity and snapshots', () => {
  it('createWorld stores a nonempty world id and starts at tick 0', () => {
    const world = createWorld('world-alpha');
    expect(world.getState()).toEqual({ worldId: 'world-alpha', tick: 0 });
    expect(world.getStatus()).toEqual({ state: 'ready' });
  });

  it('createWorld rejects an empty or non-string world id', () => {
    expect(() => createWorld('')).toThrow();
    expect(() => createWorld(undefined as unknown as string)).toThrow();
  });

  it('getState returns a fresh independent snapshot that cannot mutate the world', () => {
    const world = createWorld('w');
    const first = world.getState();
    const second = world.getState();
    expect(second).not.toBe(first);
    const mutated = first as { worldId: string; tick: number };
    mutated.worldId = 'hacked';
    mutated.tick = 99;
    expect(world.getState()).toEqual({ worldId: 'w', tick: 0 });
  });
});

describe('advancing ticks', () => {
  it('step advances the world by exactly one tick per call', () => {
    const world = createWorld('w');
    world.step();
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
    world.step();
    expect(world.getState()).toEqual({ worldId: 'w', tick: 2 });
  });

  it('run advances exactly n ticks and accepts zero', () => {
    const world = createWorld('w');
    world.run(5);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 5 });
    world.run(0);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 5 });
  });

  it('repeated step is equivalent to run', () => {
    const stepped = createWorld('same');
    const run = createWorld('same');
    for (let i = 0; i < 7; i++) {
      stepped.step();
    }
    run.run(7);
    expect(stepped.getState()).toEqual(run.getState());
  });

  it('snapshots taken earlier do not change when the world advances', () => {
    const world = createWorld('w');
    const before = world.getState();
    world.step();
    expect(before).toEqual({ worldId: 'w', tick: 0 });
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
  });

  it('world instances are independent of each other', () => {
    const a = createWorld('shared-id');
    const b = createWorld('shared-id');
    a.step();
    a.step();
    expect(a.getState()).toEqual({ worldId: 'shared-id', tick: 2 });
    expect(b.getState()).toEqual({ worldId: 'shared-id', tick: 0 });
  });

  it('runs explicitly phased tick systems by ascending phase instead of registration order', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('later-phase', () => calls.push('later'), 2);
    world.registerTickSystem('earlier-phase', () => calls.push('earlier'), -1);

    world.step();

    expect(calls).toEqual(['earlier', 'later']);
  });

  it('preserves registration order for systems in the same phase', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('first', () => calls.push('first'), 7);
    world.registerTickSystem('second', () => calls.push('second'), 7);
    world.registerTickSystem('default', () => calls.push('default'));

    world.step();

    expect(calls).toEqual(['default', 'first', 'second']);
  });

  it('runs registered tick systems in registration order on every tick', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('first', ({ tick }) => calls.push(`first:${tick}`));
    world.registerTickSystem('second', ({ tick }) => calls.push(`second:${tick}`));

    world.run(2);

    expect(calls).toEqual(['first:1', 'second:1', 'first:2', 'second:2']);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 2 });
  });

  it('fails and stops the tick when a system returns a rejected thenable', async () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('async-result', () => {
      calls.push('async-result');
      return Promise.reject(new Error('async side effect failed')) as unknown as void;
    });
    world.registerTickSystem('later', () => calls.push('later'));

    expect(() => world.step()).toThrow(/must be synchronous/);
    await Promise.resolve();

    expect(calls).toEqual(['async-result']);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
    expect(world.getStatus()).toEqual({ state: 'failed', tick: 1, systemName: 'async-result' });
    expect(() => world.step()).toThrow(/failed tick/);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
  });

  it('attributes failure to the actual system selected by phase ordering', () => {
    const world = createWorld('w');
    world.registerTickSystem('registered-first', () => undefined, 10);
    world.registerTickSystem(
      'phase-failure',
      () => {
        throw new Error('phase failed');
      },
      -10,
    );

    expect(() => world.step()).toThrow('phase failed');
    expect(world.getStatus()).toEqual({ state: 'failed', tick: 1, systemName: 'phase-failure' });
  });

  it('records a failed tick and system without undoing earlier side effects', () => {
    const world = createWorld('w');
    const effects: string[] = [];
    const failure = new Error('system failed');
    world.registerTickSystem('first', () => effects.push('mutated'));
    world.registerTickSystem('broken', () => {
      throw failure;
    });

    expect(() => world.step()).toThrow(failure);
    expect(effects).toEqual(['mutated']);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
    expect(world.getStatus()).toEqual({ state: 'failed', tick: 1, systemName: 'broken' });
  });

  it('refuses subsequent step and run calls after a failure, including run(0)', () => {
    const world = createWorld('w');
    world.registerTickSystem('broken', () => {
      throw new Error('failed');
    });
    expect(() => world.step()).toThrow('failed');

    expect(() => world.step()).toThrow(/failed tick/);
    expect(() => world.run(0)).toThrow(/failed tick/);
    expect(() => world.run(1)).toThrow(/failed tick/);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
    expect(world.getStatus()).toEqual({ state: 'failed', tick: 1, systemName: 'broken' });
  });

  it('rejects recursive advancement from a tick callback', () => {
    const world = createWorld('w');
    world.registerTickSystem('recursive', () => world.step());

    expect(() => world.step()).toThrow(/reentrant/);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 1 });
    expect(world.getStatus()).toEqual({ state: 'failed', tick: 1, systemName: 'recursive' });
  });

  it('starts systems registered during a tick on the next tick', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('register-later', ({ tick }) => {
      calls.push(`register:${tick}`);
      if (tick === 1) {
        world.registerTickSystem(
          'later',
          ({ tick: laterTick }) => calls.push(`later:${laterTick}`),
          -1,
        );
      }
    });

    world.step();
    expect(calls).toEqual(['register:1']);
    world.step();
    expect(calls).toEqual(['register:1', 'later:2', 'register:2']);
  });
});

describe('tick phase validation', () => {
  it('rejects phases that are not safe integers without registering the system', () => {
    const world = createWorld('w');
    const invalid = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const phase of invalid) {
      expect(() =>
        world.registerTickSystem(`invalid-${String(phase)}`, () => undefined, phase),
      ).toThrow(/phase must be a safe integer/);
    }
    world.registerTickSystem('valid', () => undefined, Number.MAX_SAFE_INTEGER);
    expect(() => world.step()).not.toThrow();
  });
});

describe('tick count validation', () => {
  it('run rejects non-integer, non-finite and non-number ticks with TypeError', () => {
    const world = createWorld('w');
    const invalid = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '5' as unknown as number,
    ];
    for (const bad of invalid) {
      expect(() => world.run(bad)).toThrow(TypeError);
    }
  });

  it('run rejects negative and unsafe tick counts with RangeError and leaves state unchanged', () => {
    const world = createWorld('w');
    world.run(3);
    const invalid = [-1, -100, Number.MAX_SAFE_INTEGER + 1];
    for (const bad of invalid) {
      expect(() => world.run(bad)).toThrow(RangeError);
    }
    expect(world.getState()).toEqual({ worldId: 'w', tick: 3 });
  });

  it('run accepts a large valid tick count without looping, then rejects any advance past MAX_SAFE_INTEGER', () => {
    const world = createWorld('w');
    world.run(Number.MAX_SAFE_INTEGER);
    expect(world.getState()).toEqual({
      worldId: 'w',
      tick: Number.MAX_SAFE_INTEGER,
    });
    expect(() => world.step()).toThrow(RangeError);
    expect(() => world.run(1)).toThrow(RangeError);
    expect(world.getState()).toEqual({
      worldId: 'w',
      tick: Number.MAX_SAFE_INTEGER,
    });
  });
});

describe('kingdom, city, and establishment ownership', () => {
  it('rejects duplicate kingdom IDs', () => {
    expect(() =>
      createWorldDomain({
        kingdoms: [{ id: 'k' }, { id: 'k' }],
        cities: [],
        establishments: [],
      }),
    ).toThrow(/duplicate kingdom id/);
  });

  it('rejects cities that reference a missing kingdom', () => {
    expect(() =>
      createWorldDomain({
        kingdoms: [],
        cities: [{ id: 'c', kingdomId: 'missing' }],
        establishments: [],
      }),
    ).toThrow(/unknown kingdom/);
  });

  it('rejects establishments with a missing city or owner kingdom', () => {
    expect(() =>
      createWorldDomain({
        kingdoms: [{ id: 'k' }],
        cities: [{ id: 'c', kingdomId: 'k' }],
        establishments: [{ id: 'e', cityId: 'missing', ownerKingdomId: 'k' }],
      }),
    ).toThrow(/unknown city/);
    expect(() =>
      createWorldDomain({
        kingdoms: [{ id: 'k' }],
        cities: [{ id: 'c', kingdomId: 'k' }],
        establishments: [{ id: 'e', cityId: 'c', ownerKingdomId: 'missing' }],
      }),
    ).toThrow(/unknown owner kingdom/);
  });

  it('rejects duplicate establishment IDs', () => {
    expect(() =>
      createWorldDomain({
        kingdoms: [{ id: 'k' }],
        cities: [{ id: 'c', kingdomId: 'k' }],
        establishments: [
          { id: 'e', cityId: 'c', ownerKingdomId: 'k' },
          { id: 'e', cityId: 'c', ownerKingdomId: 'k' },
        ],
      }),
    ).toThrow(/duplicate establishment id/);
  });

  it('returns read-only snapshots with explicit independent establishment ownership', () => {
    const domain = createWorldDomain({
      kingdoms: [{ id: 'kingdom-north' }, { id: 'kingdom-south' }],
      cities: [{ id: 'city-river', kingdomId: 'kingdom-north' }],
      establishments: [{ id: 'mill', cityId: 'city-river', ownerKingdomId: 'kingdom-south' }],
    });

    expect(domain.getState()).toEqual({
      kingdoms: [{ id: 'kingdom-north' }, { id: 'kingdom-south' }],
      cities: [{ id: 'city-river', kingdomId: 'kingdom-north' }],
      establishments: [{ id: 'mill', cityId: 'city-river', ownerKingdomId: 'kingdom-south' }],
    });
    expect(domain.getState()).not.toBe(domain.getState());
    const mutable = domain.getState() as {
      kingdoms: { id: string }[];
      cities: { id: string; kingdomId: string }[];
      establishments: { id: string; cityId: string; ownerKingdomId: string }[];
    };
    mutable.kingdoms[0]!.id = 'changed';
    mutable.cities.pop();
    mutable.establishments[0]!.ownerKingdomId = 'kingdom-north';
    expect(domain.getState()).toEqual({
      kingdoms: [{ id: 'kingdom-north' }, { id: 'kingdom-south' }],
      cities: [{ id: 'city-river', kingdomId: 'kingdom-north' }],
      establishments: [{ id: 'mill', cityId: 'city-river', ownerKingdomId: 'kingdom-south' }],
    });
  });
});

describe('canonical commodity catalog', () => {
  it('enumerates exactly the supported commodities in stable order', () => {
    const knownCommodities: readonly Commodity[] = ['grain', 'wood', 'tools'];
    expect(COMMODITIES).toEqual(knownCommodities);
  });

  it('contains identities only, without implied price or stock', () => {
    expect(COMMODITIES).toEqual(['grain', 'wood', 'tools']);
    expect(COMMODITIES.every((commodity) => typeof commodity === 'string')).toBe(true);
  });
});

describe('bootstrap stub preserved', () => {
  it('engineStatus still reports that no simulation is implemented', () => {
    expect(engineStatus).toEqual({ implemented: false });
  });
});
