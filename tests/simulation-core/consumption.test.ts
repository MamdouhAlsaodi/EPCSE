import { describe, expect, it } from 'vitest';
import {
  createCityMarket,
  createConsumptionSystem,
  createInventory,
  createMoneyLedger,
  createWorld,
} from '@epcse/simulation-core';

describe('population consumption', () => {
  it('rejects invalid direct cohort needs before registering a tick system', () => {
    const world = createWorld('invalid-direct-cohort');
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
    const cohort = {
      cohortId: 'families',
      cityId: 'town',
      population: 1,
      openingBudget: 1,
      needs: [
        { commodity: 'grain', quantity: 1 },
        { commodity: 'grain', quantity: 2 },
      ],
    };
    const input = {
      world,
      cohort,
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: {},
      prices: {},
      market,
      inventory,
      money,
    };

    expect(() => createConsumptionSystem(input as never)).toThrow(
      /duplicate need commodity: grain/,
    );
    const invalidNeeds = [
      [{ commodity: 'unknown', quantity: 1 }],
      [{ commodity: 'grain', quantity: 0 }],
      [{ commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER + 1 }],
      [{ commodity: 'grain', quantity: 1.5 }],
      null,
    ];
    for (const needs of invalidNeeds) {
      expect(() =>
        createConsumptionSystem({ ...input, cohort: { ...cohort, needs } } as never),
      ).toThrow();
    }
    expect(world.getState()).toEqual({ worldId: 'invalid-direct-cohort', tick: 0 });
    expect(world.getStatus()).toEqual({ state: 'ready' });
    expect(inventory.getState().balances).toEqual([]);
    expect(money.getState().balances).toEqual([
      { accountId: 'household-cash', amount: 0 },
      { accountId: 'seller-cash', amount: 0 },
    ]);

    expect(() =>
      createConsumptionSystem({ ...input, cohort: { ...cohort, needs: [] } }),
    ).not.toThrow();
  });
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

  it('does not partially settle built-in multi-commodity consumption when a later seller balance overflows', () => {
    const inventory = createInventory({
      owners: ['household', 'grain-seller', 'wood-seller'],
      balances: [
        { ownerId: 'grain-seller', commodity: 'grain', quantity: 1 },
        { ownerId: 'wood-seller', commodity: 'wood', quantity: 1 },
      ],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'grain-cash', 'wood-cash'],
      balances: [
        { accountId: 'household-cash', amount: 2 },
        { accountId: 'wood-cash', amount: Number.MAX_SAFE_INTEGER },
      ],
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
    const world = createWorld('atomic-consumption-world');
    const consumer = createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 2,
        needs: [
          { commodity: 'grain', quantity: 1 },
          { commodity: 'wood', quantity: 1 },
        ],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'grain-seller', wood: 'wood-seller' },
      prices: { grain: 1, wood: 1 },
      market,
      inventory,
      money,
      initialState: {
        unmetNeeds: [
          { commodity: 'grain', quantity: 1 },
          { commodity: 'wood', quantity: 1 },
        ],
        cumulativeUnmetNeeds: [],
      },
    });
    const beforeInventory = inventory.getState();
    const beforeMoney = money.getState();

    expect(() => world.step()).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(beforeInventory);
    expect(money.getState()).toEqual(beforeMoney);
    expect(consumer.getUnmetNeeds()).toEqual([
      { commodity: 'grain', quantity: 1 },
      { commodity: 'wood', quantity: 1 },
    ]);
    expect(consumer.getCumulativeUnmetNeeds()).toEqual([]);
  });

  it('preflights cumulative payments through a shared seller account across commodities', () => {
    const inventory = createInventory({
      owners: ['household', 'seller'],
      balances: [
        { ownerId: 'seller', commodity: 'grain', quantity: 1 },
        { ownerId: 'seller', commodity: 'wood', quantity: 1 },
      ],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'seller-cash'],
      balances: [
        { accountId: 'household-cash', amount: 2 },
        { accountId: 'seller-cash', amount: Number.MAX_SAFE_INTEGER - 1 },
      ],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    const world = createWorld('shared-seller-account-world');
    const consumer = createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 2,
        needs: [
          { commodity: 'grain', quantity: 1 },
          { commodity: 'wood', quantity: 1 },
        ],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'seller', wood: 'seller' },
      prices: { grain: 1, wood: 1 },
      market,
      inventory,
      money,
    });
    const beforeInventory = inventory.getState();
    const beforeMoney = money.getState();

    expect(() => world.step()).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(beforeInventory);
    expect(money.getState()).toEqual(beforeMoney);
    expect(consumer.getUnmetNeeds()).toEqual([
      { commodity: 'grain', quantity: 1 },
      { commodity: 'wood', quantity: 1 },
    ]);
    expect(consumer.getCumulativeUnmetNeeds()).toEqual([]);
  });

  it('rejects consumption ledgers that differ from the built-in market ledgers before mutation', () => {
    const marketInventory = createInventory({
      owners: ['household', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 1 }],
    });
    const marketMoney = createMoneyLedger({
      accounts: ['household-cash', 'seller-cash'],
      balances: [{ accountId: 'household-cash', amount: 1 }],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory: marketInventory,
      money: marketMoney,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    const inventory = createInventory({
      owners: ['household', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'seller-cash'],
      balances: [{ accountId: 'household-cash', amount: 1 }],
    });
    const world = createWorld('mismatched-ledgers');
    createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 1,
        needs: [{ commodity: 'grain', quantity: 1 }],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'seller' },
      prices: { grain: 1 },
      market,
      inventory,
      money,
    });
    const marketBefore = [marketInventory.getState(), marketMoney.getState()];
    const inputBefore = [inventory.getState(), money.getState()];
    expect(() => world.step()).toThrow(/ledger/i);
    expect([marketInventory.getState(), marketMoney.getState()]).toEqual(marketBefore);
    expect([inventory.getState(), money.getState()]).toEqual(inputBefore);
  });

  it('rejects a configured buyer account that differs from the market participant account', () => {
    const inventory = createInventory({
      owners: ['household', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['market-household-cash', 'configured-cash', 'seller-cash'],
      balances: [{ accountId: 'configured-cash', amount: 1 }],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'market-household-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    const world = createWorld('buyer-account-mismatch');
    createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 1,
        needs: [{ commodity: 'grain', quantity: 1 }],
      },
      buyer: { ownerId: 'household', accountId: 'configured-cash' },
      sellers: { grain: 'seller' },
      prices: { grain: 1 },
      market,
      inventory,
      money,
    });
    const before = [inventory.getState(), money.getState()];
    expect(() => world.step()).toThrow(/account/i);
    expect([inventory.getState(), money.getState()]).toEqual(before);
  });

  it('preserves a replaced built-in market trade override rather than bypassing it', () => {
    const inventory = createInventory({
      owners: ['household', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'seller-cash'],
      balances: [{ accountId: 'household-cash', amount: 1 }],
    });
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    let calls = 0;
    const originalTrade = market.trade;
    market.trade = (trade) => {
      calls += 1;
      return originalTrade(trade);
    };
    const world = createWorld('overridden-trade');
    createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 1,
        needs: [{ commodity: 'grain', quantity: 1 }],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'seller' },
      prices: { grain: 1 },
      market,
      inventory,
      money,
    });
    world.step();
    expect(calls).toBe(1);
  });

  it('does not use atomic settlement when built-in ledger methods have been replaced', () => {
    const inventory = createInventory({
      owners: ['household', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['household-cash', 'seller-cash'],
      balances: [{ accountId: 'household-cash', amount: 1 }],
    });
    const originalInventoryTransfer = inventory.transfer;
    const originalMoneyTransfer = money.transfer;
    let inventoryCalls = 0;
    let moneyCalls = 0;
    inventory.transfer = (...args) => {
      inventoryCalls += 1;
      return originalInventoryTransfer(...args);
    };
    money.transfer = (...args) => {
      moneyCalls += 1;
      return originalMoneyTransfer(...args);
    };
    const market = createCityMarket({
      cityId: 'town',
      inventory,
      money,
      participants: [
        { ownerId: 'household', accountId: 'household-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    const world = createWorld('replaced-ledger-methods');
    createConsumptionSystem({
      world,
      cohort: {
        cohortId: 'families',
        cityId: 'town',
        population: 1,
        openingBudget: 1,
        needs: [{ commodity: 'grain', quantity: 1 }],
      },
      buyer: { ownerId: 'household', accountId: 'household-cash' },
      sellers: { grain: 'seller' },
      prices: { grain: 1 },
      market,
      inventory,
      money,
    });
    world.step();
    expect(inventoryCalls).toBe(1);
    expect(moneyCalls).toBe(1);
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
