import { describe, expect, it } from 'vitest';
import { createInventory } from '@epcse/simulation-core';

describe('inventory transfers', () => {
  it('transfers a commodity between explicitly initialized owners', () => {
    const inventory = createInventory({
      owners: ['north', 'south'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 7 }],
    });

    inventory.transfer('north', 'south', 'grain', 3);

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 4 },
        { ownerId: 'south', commodity: 'grain', quantity: 3 },
      ],
    });
  });

  it('treats a same-owner transfer as a no-op without changing stock', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });

    expect(inventory.transfer('north', 'north', 'grain', 2)).toEqual({
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    expect(inventory.getState()).toEqual({
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
  });

  it('rejects invalid transfer amounts without changing either balance', () => {
    const inventory = createInventory({
      owners: ['north', 'south'],
      balances: [{ ownerId: 'north', commodity: 'wood', quantity: 8 }],
    });
    const before = inventory.getState();

    for (const quantity of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => inventory.transfer('north', 'south', 'wood', quantity)).toThrow();
      expect(inventory.getState()).toEqual(before);
    }
  });

  it('rejects insufficient stock and unknown owners without mutation', () => {
    const inventory = createInventory({
      owners: ['north', 'south'],
      balances: [{ ownerId: 'north', commodity: 'tools', quantity: 2 }],
    });

    expect(() => inventory.transfer('north', 'south', 'tools', 3)).toThrow(/insufficient/);
    expect(() => inventory.transfer('missing', 'south', 'tools', 1)).toThrow(/unknown source/);
    expect(() => inventory.transfer('north', 'missing', 'tools', 1)).toThrow(/unknown destination/);
    expect(inventory.getState()).toEqual({
      balances: [{ ownerId: 'north', commodity: 'tools', quantity: 2 }],
    });
  });

  it('rejects destination overflow atomically', () => {
    const inventory = createInventory({
      owners: ['north', 'south'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 1 },
        { ownerId: 'south', commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER },
      ],
    });
    const before = inventory.getState();

    expect(() => inventory.transfer('north', 'south', 'grain', 1)).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(before);
  });

  it('returns defensive snapshots and rejects invalid initial balances', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 4 }],
    });
    const snapshot = inventory.getState() as unknown as { balances: { quantity: number }[] };
    snapshot.balances[0]!.quantity = 99;
    snapshot.balances.pop();
    expect(inventory.getState()).toEqual({
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 4 }],
    });

    for (const quantity of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createInventory({
          owners: ['north'],
          balances: [{ ownerId: 'north', commodity: 'grain', quantity }],
        }),
      ).toThrow();
    }
    expect(() =>
      createInventory({
        owners: ['north'],
        balances: [{ ownerId: 'missing', commodity: 'grain', quantity: 1 }],
      }),
    ).toThrow(/unknown owner/);
  });
});

describe('explicit production', () => {
  // Synthetic/provisional recipe example only; production is driven by caller-supplied data.
  it('consumes recipe inputs and adds recipe outputs for a batch', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 8 }],
    });

    inventory.produce(
      'north',
      {
        inputs: [{ commodity: 'grain', quantity: 2 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
      3,
    );

    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 2 },
        { ownerId: 'north', commodity: 'tools', quantity: 3 },
      ],
    });
  });

  it('requires gross inputs before applying overlapping recipe outputs', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const recipe = {
      inputs: [{ commodity: 'grain' as const, quantity: 3 }],
      outputs: [{ commodity: 'grain' as const, quantity: 4 }],
    };
    const before = inventory.getState();

    expect(() => inventory.produce('north', recipe, 1)).toThrow(/insufficient/);
    expect(inventory.getState()).toEqual(before);

    const sufficient = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 3 }],
    });
    sufficient.produce('north', recipe, 1);
    expect(sufficient.getState()).toEqual({
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 4 }],
    });
  });

  it('rejects invalid recipes and arithmetic atomically', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    const before = inventory.getState();
    const valid = {
      inputs: [{ commodity: 'grain' as const, quantity: 1 }],
      outputs: [{ commodity: 'tools' as const, quantity: 1 }],
    };
    const invalidRecipes = [
      { ...valid, inputs: [] },
      { ...valid, outputs: [] },
      { ...valid, inputs: [{ commodity: 'grain' as const, quantity: 0 }] },
      {
        ...valid,
        inputs: [
          { commodity: 'grain' as const, quantity: 1 },
          { commodity: 'grain' as const, quantity: 2 },
        ],
      },
    ];

    for (const recipe of invalidRecipes) {
      expect(() => inventory.produce('north', recipe, 1)).toThrow();
      expect(inventory.getState()).toEqual(before);
    }
    expect(() => inventory.produce('missing', valid, 1)).toThrow(/unknown owner/);
    expect(() => inventory.produce('north', valid, 0)).toThrow(/batch count/);
    expect(() => inventory.produce('north', valid, 2)).not.toThrow();
  });

  it('rejects a batch total that exceeds safe integer range before mutation', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER }],
    });
    const before = inventory.getState();

    expect(() =>
      inventory.produce(
        'north',
        {
          inputs: [{ commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER }],
          outputs: [{ commodity: 'tools', quantity: 1 }],
        },
        2,
      ),
    ).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(before);
  });

  it('rejects output overflow without consuming inputs', () => {
    const inventory = createInventory({
      owners: ['north'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 2 },
        { ownerId: 'north', commodity: 'tools', quantity: Number.MAX_SAFE_INTEGER },
      ],
    });
    const before = inventory.getState();

    expect(() =>
      inventory.produce(
        'north',
        {
          inputs: [{ commodity: 'grain', quantity: 1 }],
          outputs: [{ commodity: 'tools', quantity: 1 }],
        },
        1,
      ),
    ).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(before);
  });
});
