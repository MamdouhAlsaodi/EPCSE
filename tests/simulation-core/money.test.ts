import { describe, expect, it } from 'vitest';
import { createCityMarket, createInventory, createMoneyLedger } from '@epcse/simulation-core';

describe('explicit city market trades', () => {
  it('exchanges goods and money for the supplied unit price', () => {
    const inventory = createInventory({
      owners: ['buyer', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: 8 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 40 }],
    });
    const market = createCityMarket({
      cityId: 'harbor',
      inventory,
      money,
      participants: [
        { ownerId: 'buyer', accountId: 'buyer-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });

    expect(
      market.trade({
        cityId: 'harbor',
        buyerId: 'buyer',
        sellerId: 'seller',
        commodity: 'grain',
        quantity: 3,
        unitPrice: 7,
      }),
    ).toEqual({
      cityId: 'harbor',
      buyerId: 'buyer',
      sellerId: 'seller',
      commodity: 'grain',
      quantity: 3,
      unitPrice: 7,
      total: 21,
    });
    expect(inventory.getState()).toEqual({
      balances: [
        { ownerId: 'buyer', commodity: 'grain', quantity: 3 },
        { ownerId: 'seller', commodity: 'grain', quantity: 5 },
      ],
    });
    expect(money.getState()).toEqual({
      balances: [
        { accountId: 'buyer-cash', amount: 19 },
        { accountId: 'seller-cash', amount: 21 },
      ],
    });
  });

  it('rejects any failed preflight without changing either ledger', () => {
    const inventory = createInventory({
      owners: ['buyer', 'seller'],
      balances: [{ ownerId: 'seller', commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [
        { accountId: 'buyer-cash', amount: 5 },
        { accountId: 'seller-cash', amount: Number.MAX_SAFE_INTEGER },
      ],
    });
    const market = createCityMarket({
      cityId: 'harbor',
      inventory,
      money,
      participants: [
        { ownerId: 'buyer', accountId: 'buyer-cash' },
        { ownerId: 'seller', accountId: 'seller-cash' },
      ],
    });
    const inventoryBefore = inventory.getState();
    const moneyBefore = money.getState();

    for (const trade of [
      {
        cityId: 'elsewhere',
        buyerId: 'buyer',
        sellerId: 'seller',
        commodity: 'grain' as const,
        quantity: 1,
        unitPrice: 1,
      },
      {
        cityId: 'harbor',
        buyerId: 'buyer',
        sellerId: 'seller',
        commodity: 'grain' as const,
        quantity: 1,
        unitPrice: 6,
      },
      {
        cityId: 'harbor',
        buyerId: 'buyer',
        sellerId: 'seller',
        commodity: 'grain' as const,
        quantity: 1,
        unitPrice: 1,
      },
      {
        cityId: 'harbor',
        buyerId: 'buyer',
        sellerId: 'buyer',
        commodity: 'grain' as const,
        quantity: 1,
        unitPrice: 1,
      },
    ]) {
      expect(() => market.trade(trade)).toThrow();
      expect(inventory.getState()).toEqual(inventoryBefore);
      expect(money.getState()).toEqual(moneyBefore);
    }
  });
});

describe('money transfers', () => {
  it('rejects invalid opening balances and account declarations', () => {
    for (const amount of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createMoneyLedger({ accounts: ['a'], balances: [{ accountId: 'a', amount }] }),
      ).toThrow();
    }
    expect(() => createMoneyLedger({ accounts: ['a', 'a'] })).toThrow(/duplicate account/);
    expect(() =>
      createMoneyLedger({ accounts: ['a'], balances: [{ accountId: 'missing', amount: 1 }] }),
    ).toThrow(/unknown account/);
  });

  it('rejects invalid transfers atomically', () => {
    const ledger = createMoneyLedger({
      accounts: ['a', 'b'],
      balances: [
        { accountId: 'a', amount: 2 },
        { accountId: 'b', amount: Number.MAX_SAFE_INTEGER },
      ],
    });
    const before = ledger.getState();

    for (const amount of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ledger.transfer('a', 'b', amount)).toThrow();
      expect(ledger.getState()).toEqual(before);
    }
    expect(() => ledger.transfer('missing', 'b', 1)).toThrow(/unknown source/);
    expect(() => ledger.transfer('a', 'missing', 1)).toThrow(/unknown destination/);
    expect(() => ledger.transfer('a', 'b', 3)).toThrow(/insufficient/);
    expect(() => ledger.transfer('a', 'b', 1)).toThrow(/exceed/);
    expect(ledger.getState()).toEqual(before);
  });

  it('makes a valid same-account transfer a no-op', () => {
    const ledger = createMoneyLedger({
      accounts: ['a'],
      balances: [{ accountId: 'a', amount: 1 }],
    });

    expect(ledger.transfer('a', 'a', 2)).toEqual({
      balances: [{ accountId: 'a', amount: 1 }],
    });
    expect(() => ledger.transfer('a', 'a', 0)).toThrow();
  });

  it('returns defensive deterministic snapshots', () => {
    const ledger = createMoneyLedger({ accounts: ['b', 'a'] });
    const snapshot = ledger.getState() as { balances: { accountId: string; amount: number }[] };
    snapshot.balances[0]!.amount = 10;
    snapshot.balances.reverse();
    snapshot.balances.pop();

    expect(ledger.getState()).toEqual({
      balances: [
        { accountId: 'b', amount: 0 },
        { accountId: 'a', amount: 0 },
      ],
    });
  });

  it('transfers a positive integer amount between explicitly opened accounts', () => {
    const ledger = createMoneyLedger({
      accounts: ['north', 'south'],
      balances: [{ accountId: 'north', amount: 7 }],
    });

    const result = ledger.transfer('north', 'south', 3);

    expect(result).toEqual({
      balances: [
        { accountId: 'north', amount: 4 },
        { accountId: 'south', amount: 3 },
      ],
    });
    expect(ledger.getState()).toEqual(result);
  });
});
