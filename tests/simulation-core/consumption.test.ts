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
    const snapshot = consumer.getCumulativeUnmetNeeds() as {
      commodity: string;
      quantity: number;
    }[];
    snapshot[0]!.quantity = 99;
    snapshot.push({ commodity: 'grain', quantity: 100 });
    expect(consumer.getCumulativeUnmetNeeds()).toEqual([
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
    expect(consumer.getCumulativeUnmetNeeds()).toEqual([
      { commodity: 'grain', quantity: 6 },
      { commodity: 'wood', quantity: 1 },
    ]);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'wood-seller', commodity: 'wood', quantity: 2 },
    ]);
  });

  it('rejects malformed or cohort-inconsistent initial consumption state', () => {
    const makeConsumer = (initialState: unknown) => {
      const inventory = createInventory({ owners: ['household', 'seller'] });
      const money = createMoneyLedger({ accounts: ['household-cash', 'seller-cash'] });
      const market = createCityMarket({
        cityId: 'town',
        inventory,
        money,
        participants: [
          { ownerId: 'household', accountId: 'household-cash' },
          { ownerId: 'seller', accountId: 'seller-cash' },
        ],
      });
      return createConsumptionSystem({
        world: createWorld('initial-consumption'),
        cohort: {
          cohortId: 'families',
          cityId: 'town',
          population: 1,
          openingBudget: 1,
          needs: [{ commodity: 'grain', quantity: 2 }],
        },
        buyer: { ownerId: 'household', accountId: 'household-cash' },
        sellers: {},
        prices: {},
        market,
        inventory,
        money,
        initialState: initialState as never,
      });
    };
    const invalidStates = [
      null,
      { unmetNeeds: {}, cumulativeUnmetNeeds: [] },
      { unmetNeeds: [{ commodity: 'wood', quantity: 1 }], cumulativeUnmetNeeds: [] },
      { unmetNeeds: [{ commodity: 'grain', quantity: 3 }], cumulativeUnmetNeeds: [] },
      { unmetNeeds: [{ commodity: 'grain', quantity: 0 }], cumulativeUnmetNeeds: [] },
      {
        unmetNeeds: [{ commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER + 1 }],
        cumulativeUnmetNeeds: [],
      },
      { unmetNeeds: [null], cumulativeUnmetNeeds: [] },
      { unmetNeeds: [], cumulativeUnmetNeeds: [{ commodity: 'wood', quantity: 1 }] },
      {
        unmetNeeds: [],
        cumulativeUnmetNeeds: [{ commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER + 1 }],
      },
      {
        unmetNeeds: [],
        cumulativeUnmetNeeds: [
          { commodity: 'grain', quantity: 1 },
          { commodity: 'grain', quantity: 2 },
        ],
      },
    ];

    for (const initialState of invalidStates) {
      expect(() => makeConsumer(initialState)).toThrow(RangeError);
    }
  });

  it('checks cumulative overflow before making any trades in the tick', () => {
    const inventory = createInventory({
      owners: ['household', 'grain-seller'],
      balances: [{ ownerId: 'grain-seller', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'grain-cash'],
      balances: [{ accountId: 'household-cash', amount: 1 }],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'grain-seller', accountId: 'grain-cash' },
      ],
    });
    const sellers: Partial<Record<'grain' | 'wood', string>> = {};
    const world = createWorld('overflow-world');
    const consumer = createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 1,
        needs: [
          { commodity: 'grain', quantity: 1 },
          { commodity: 'wood', quantity: Number.MAX_SAFE_INTEGER },
        ],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers,
      prices: { grain: 1, wood: 1 },
      market,
      inventory,
      money,
    });

    world.step();
    sellers.grain = 'grain-seller';
    expect(() => world.step()).toThrow(/safe integer/);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'grain-seller', commodity: 'grain', quantity: 1 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'household-cash', amount: 1 },
      { accountId: 'grain-cash', amount: 0 },
    ]);
    expect(consumer.getCumulativeUnmetNeeds()).toEqual([
      { commodity: 'grain', quantity: 1 },
      { commodity: 'wood', quantity: Number.MAX_SAFE_INTEGER },
    ]);
  });
});
