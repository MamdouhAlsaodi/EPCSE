import { describe, expect, it } from 'vitest';
import { createMoneyLedger } from '@epcse/simulation-core';

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
