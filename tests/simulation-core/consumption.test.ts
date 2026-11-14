import { describe, expect, it } from 'vitest';
import {
  createCityMarket,
  createConsumptionSystem,
  createInventory,
  createMoneyLedger,
  createWorld,
} from '@epcse/simulation-core';

describe('population consumption', () => {
  it('buys within actual funds and stock, consumes purchases, and carries unmet need into the next tick', () => {
    const inventory = createInventory({
      owners: ['household', 'grain-seller', 'wood-seller'],
      balances: [
        { ownerId: 'grain-seller', commodity: 'grain', quantity: 2 },
        { ownerId: 'wood-seller', commodity: 'wood', quantity: 5 },
      ],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'grain-cash', 'wood-cash'],
      balances: [{ accountId: 'household-cash', amount: 5 }],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'grain-seller', accountId: 'grain-cash' },
        { ownerId: 'wood-seller', accountId: 'wood-cash' },
      ],
    });
    const world = createWorld('test-world');
    const consumer = createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 99,
        needs: [
          { commodity: 'grain', quantity: 4 },
          { commodity: 'wood', quantity: 2 },
        ],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'grain-seller', wood: 'wood-seller' },
      prices: { grain: 2, wood: 1 },
      market,
      inventory,
      money,
    });

    world.step();
    expect(consumer.getUnmetNeeds()).toEqual([
      { commodity: 'grain', quantity: 2 },
      { commodity: 'wood', quantity: 1 },
    ]);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'wood-seller', commodity: 'wood', quantity: 4 },
    ]);
    expect(money.getState().balances[0]).toEqual({ accountId: 'household-cash', amount: 0 });

    money.transfer('grain-cash', 'household-cash', 3);
    world.step();
    expect(consumer.getUnmetNeeds()).toEqual([{ commodity: 'grain', quantity: 4 }]);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'wood-seller', commodity: 'wood', quantity: 2 },
    ]);
  });
});
