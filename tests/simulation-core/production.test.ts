import { describe, expect, it } from 'vitest';
import { createInventory, createRecipeProducer, createWorld } from '@epcse/simulation-core';

describe('recipe-driven production', () => {
  it('produces one batch on each world tick while running', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 6 }],
    });
    const producer = createRecipeProducer(world, 'mill', inventory, 'north', {
      inputs: [{ commodity: 'grain', quantity: 2 }],
      outputs: [{ commodity: 'tools', quantity: 1 }],
    });

    world.run(2);

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 2 },
        { ownerId: 'north', commodity: 'tools', quantity: 2 },
      ],
    });
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 2 });
  });

  it('produces up to the configured batch cap per tick', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 12 }],
    });
    const producer = createRecipeProducer(
      world,
      'mill',
      inventory,
      'north',
      {
        inputs: [{ commodity: 'grain', quantity: 2 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
      { maxBatchesPerTick: 3 },
    );

    world.step();

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 6 },
        { ownerId: 'north', commodity: 'tools', quantity: 3 },
      ],
    });
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 3 });
  });

  it('limits batches by output safe-integer headroom', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 6 },
        { ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER - 1 },
      ],
    });
    const producer = createRecipeProducer(
      world,
      'mill',
      inventory,
      'north',
      {
        inputs: [{ commodity: 'grain', quantity: 2 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
      { maxBatchesPerTick: 3 },
    );

    world.step();

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 4 },
        { ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER },
      ],
    });
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 1 });
  });

  it('uses net output growth for overlapping input and output commodities', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER - 2 }],
    });
    const producer = createRecipeProducer(
      world,
      'mill',
      inventory,
      'north',
      {
        inputs: [{ commodity: 'tools', quantity: 2 }],
        outputs: [{ commodity: 'tools', quantity: 3 }],
      },
      { maxBatchesPerTick: 3 },
    );

    world.step();

    expect(inventory.getState()).toEqual({
      balances: [{ ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER }],
    });
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 2 });
  });

  it('does not report missing inputs when output headroom is zero', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 3 },
        { ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER },
      ],
    });
    const producer = createRecipeProducer(
      world,
      'mill',
      inventory,
      'north',
      {
        inputs: [{ commodity: 'grain', quantity: 1 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
      { maxBatchesPerTick: 3 },
    );
    const before = inventory.getState();

    expect(() => world.step()).toThrow(/production inventory would exceed/);
    expect(inventory.getState()).toEqual(before);
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 0 });
  });

  it('produces only the feasible partial capacity and stops on a later empty tick', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    const producer = createRecipeProducer(
      world,
      'mill',
      inventory,
      'north',
      {
        inputs: [{ commodity: 'grain', quantity: 2 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
      { maxBatchesPerTick: 3 },
    );

    world.step();
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 2 });
    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 1 },
        { ownerId: 'north', commodity: 'tools', quantity: 2 },
      ],
    });

    world.step();
    expect(producer.getState()).toEqual({
      status: 'stopped',
      batchesProduced: 2,
      stoppedReason: 'missing-inputs',
    });
  });

  it('rejects invalid initial statuses, stopped reasons, and batch counts', () => {
    const recipe = {
      inputs: [{ commodity: 'grain' as const, quantity: 1 }],
      outputs: [{ commodity: 'tools' as const, quantity: 1 }],
    };
    const invalidStates = [
      { batchesProduced: 0 },
      { status: 'paused', batchesProduced: 0 },
      { status: 'stopped', stoppedReason: 'unknown', batchesProduced: 0 },
      { status: 'running', stoppedReason: 'missing-inputs', batchesProduced: 0 },
      { status: 'running', batchesProduced: -1 },
      { status: 'running', batchesProduced: 1.5 },
      { status: 'running', batchesProduced: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const [index, initialState] of invalidStates.entries()) {
      let rejected = false;
      try {
        createRecipeProducer(
          createWorld(`invalid-initial-${index}`),
          `producer-${index}`,
          createInventory({ owners: ['north'] }),
          'north',
          recipe,
          { initialState: initialState as never },
        );
      } catch (error) {
        rejected = error instanceof RangeError;
      }
      expect(rejected, JSON.stringify(initialState)).toBe(true);
    }
  });

  it('rejects a non-positive or unsafe batch cap', () => {
    const world = createWorld('w');
    const inventory = createInventory({ owners: ['north'] });
    const recipe = {
      inputs: [{ commodity: 'grain' as const, quantity: 1 }],
      outputs: [{ commodity: 'tools' as const, quantity: 1 }],
    };

    expect(() =>
      createRecipeProducer(world, 'zero', inventory, 'north', recipe, { maxBatchesPerTick: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createRecipeProducer(world, 'fraction', inventory, 'north', recipe, {
        maxBatchesPerTick: 1.5,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createRecipeProducer(world, 'unsafe', inventory, 'north', recipe, {
        maxBatchesPerTick: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(RangeError);
  });

  it('throws for invalid input recipes even when input stock is missing', () => {
    const world = createWorld('w');
    const inventory = createInventory({ owners: ['north'] });
    const producer = createRecipeProducer(world, 'mill', inventory, 'north', {
      inputs: [
        { commodity: 'grain', quantity: 1 },
        { commodity: 'grain', quantity: 2 },
      ],
      outputs: [{ commodity: 'tools', quantity: 1 }],
    });
    const before = inventory.getState();

    expect(() => world.step()).toThrow(/duplicate recipe commodity/);
    expect(inventory.getState()).toEqual(before);
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 0 });
  });

  it('throws for invalid output recipes even when input stock is missing', () => {
    const world = createWorld('w');
    const inventory = createInventory({ owners: ['north'] });
    const producer = createRecipeProducer(world, 'mill', inventory, 'north', {
      inputs: [{ commodity: 'grain', quantity: 1 }],
      outputs: [{ commodity: 'tools', quantity: 0 }],
    });
    const before = inventory.getState();

    expect(() => world.step()).toThrow(/recipe quantities/);
    expect(inventory.getState()).toEqual(before);
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 0 });
  });

  it('throws for an unknown owner even when input stock is missing', () => {
    const world = createWorld('w');
    const inventory = createInventory({ owners: ['north'] });
    const producer = createRecipeProducer(world, 'mill', inventory, 'missing', {
      inputs: [{ commodity: 'grain', quantity: 1 }],
      outputs: [{ commodity: 'tools', quantity: 1 }],
    });
    const before = inventory.getState();

    expect(() => world.step()).toThrow(/unknown owner/);
    expect(inventory.getState()).toEqual(before);
    expect(producer.getState()).toEqual({ status: 'running', batchesProduced: 0 });
  });

  it('stops atomically when inputs run out and does not retry on later ticks', () => {
    const world = createWorld('w');
    const inventory = createInventory({
      owners: ['north', 'reserve'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 1 },
        { ownerId: 'reserve', commodity: 'grain', quantity: 2 },
      ],
    });
    const producer = createRecipeProducer(world, 'mill', inventory, 'north', {
      inputs: [{ commodity: 'grain', quantity: 1 }],
      outputs: [{ commodity: 'tools', quantity: 1 }],
    });

    world.step();
    const beforeMissingInputs = inventory.getState();
    world.step();

    expect(inventory.getState()).toEqual(beforeMissingInputs);
    expect(producer.getState()).toEqual({
      status: 'stopped',
      batchesProduced: 1,
      stoppedReason: 'missing-inputs',
    });

    inventory.transfer('reserve', 'north', 'grain', 1);
    world.step();

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 1 },
        { ownerId: 'north', commodity: 'tools', quantity: 1 },
        { ownerId: 'reserve', commodity: 'grain', quantity: 1 },
      ],
    });
    expect(producer.getState()).toEqual({
      status: 'stopped',
      batchesProduced: 1,
      stoppedReason: 'missing-inputs',
    });
  });
});
