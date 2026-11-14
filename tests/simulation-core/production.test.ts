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
