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
