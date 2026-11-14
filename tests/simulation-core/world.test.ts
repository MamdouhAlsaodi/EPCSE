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

  it('runs registered tick systems in registration order on every tick', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('first', ({ tick }) => calls.push(`first:${tick}`));
    world.registerTickSystem('second', ({ tick }) => calls.push(`second:${tick}`));

    world.run(2);

    expect(calls).toEqual(['first:1', 'second:1', 'first:2', 'second:2']);
    expect(world.getState()).toEqual({ worldId: 'w', tick: 2 });
  });

  it('starts systems registered during a tick on the next tick', () => {
    const world = createWorld('w');
    const calls: string[] = [];
    world.registerTickSystem('register-later', ({ tick }) => {
      calls.push(`register:${tick}`);
      if (tick === 1) {
        world.registerTickSystem('later', ({ tick: laterTick }) =>
          calls.push(`later:${laterTick}`),
        );
      }
    });

    world.step();
    expect(calls).toEqual(['register:1']);
    world.step();
    expect(calls).toEqual(['register:1', 'register:2', 'later:2']);
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
