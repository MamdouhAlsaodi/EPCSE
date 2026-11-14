import { describe, expect, it } from 'vitest';
import {
  createCityMarket,
  createInventory,
  createMoneyLedger,
  createWorld,
  registerMarketClearing,
} from '../../packages/simulation-core/src/index.js';

describe('recurring market clearing', () => {
  it('caps trade quantity to what the buyer account can afford', () => {
    const world = createWorld('world');
    const inventory = createInventory({
      owners: ['buyer', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 3 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-account', 'seller-account'],
      balances: [{ accountId: 'buyer-account', amount: 15 }],
    });
    const market = createCityMarket({
      cityId: 'city',
      inventory,
      money,
      participants: [
        { ownerId: 'buyer', accountId: 'buyer-account' },
        { ownerId: 'seller', accountId: 'seller-account' },
      ],
    });
    const outcomes: Array<{ tick: number; price: number; quantity: number; unmetDemand: number }> =
      [];

    registerMarketClearing({
      world,
      cityId: 'city',
      commodity: 'grain',
      buyerId: 'buyer',
      buyerAccountId: 'buyer-account',
      sellerId: 'seller',
      desiredDemand: 3,
      basePrice: 10,
      maxPrice: 20,
      inventory,
      market,
      money,
      onTick: (outcome) => outcomes.push(outcome),
    });

    world.run(1);

    expect(outcomes).toEqual([{ tick: 1, price: 10, quantity: 1, unmetDemand: 2 }]);
    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'buyer',
      commodity: 'grain',
      quantity: 1,
    });
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-account', amount: 5 },
      { accountId: 'seller-account', amount: 10 },
    ]);
  });

  it('prices and settles each tick against current seller stock and fixed demand', () => {
    const world = createWorld('world');
    const inventory = createInventory({
      owners: ['buyer', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 3 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-account', 'seller-account'],
      balances: [{ accountId: 'buyer-account', amount: 100 }],
    });
    const market = createCityMarket({
      cityId: 'city',
      inventory,
      money,
      participants: [
        { ownerId: 'buyer', accountId: 'buyer-account' },
        { ownerId: 'seller', accountId: 'seller-account' },
      ],
    });
    const outcomes: Array<{ tick: number; price: number; quantity: number; unmetDemand: number }> =
      [];

    registerMarketClearing({
      world,
      cityId: 'city',
      commodity: 'grain',
      buyerId: 'buyer',
      buyerAccountId: 'buyer-account',
      sellerId: 'seller',
      desiredDemand: 2,
      basePrice: 10,
      maxPrice: 20,
      inventory,
      market,
      money,
      onTick: (outcome) => outcomes.push(outcome),
    });

    world.run(2);

    expect(outcomes).toEqual([
      { tick: 1, price: 7, quantity: 2, unmetDemand: 0 },
      { tick: 2, price: 15, quantity: 1, unmetDemand: 1 },
    ]);
    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'buyer',
      commodity: 'grain',
      quantity: 3,
    });
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-account', amount: 71 },
      { accountId: 'seller-account', amount: 29 },
    ]);
  });
});
