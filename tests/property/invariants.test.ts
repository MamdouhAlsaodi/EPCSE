import { describe, expect, it } from 'vitest';

const money = (minor: number) => ({
  kind: 'money' as const,
  currencyId: 'coin',
  unit: 'cent',
  scale: 2,
  minor,
});
import {
  applyAccountingTransaction,
  assertAccountingInvariant,
  createAccountingState,
} from '../../packages/simulation-core/src/services/accounting/index.js';

describe('accounting invariants under deterministic generated transfers', () => {
  it('preserves total money and nonnegative commodity balances', () => {
    let state = createAccountingState({
      currency: { id: 'coin', unit: 'cent', scale: 2 },
      commodities: [{ id: 'grain', unit: 'kg', scale: 3 }],
      owners: ['a', 'b'],
      accounts: [
        { id: 'a', ownerId: 'a', openingBalance: 1000 },
        { id: 'b', ownerId: 'b', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'a', commodity: 'grain', quantity: 500 }],
    });
    for (let index = 0; index < 80; index++) {
      const amount = 1;
      const from = index % 2 === 0 ? 'a' : 'b';
      const to = from === 'a' ? 'b' : 'a';
      const source = state.accounts.find((account) => account.id === from)!.balance;
      if (source >= amount)
        state = applyAccountingTransaction(
          state,
          [
            {
              type: 'payment',
              fromAccountId: from,
              toAccountId: to,
              amount: money(amount),
              causeId: `cause-${index}`,
            },
          ],
          `tx-${index}`,
        );
      assertAccountingInvariant(state);
      expect(state.accounts.reduce((sum, account) => sum + account.balance, 0)).toBe(1000);
      expect(state.stock.every((balance) => balance.quantity >= 0)).toBe(true);
    }
    expect(state.journal).toHaveLength(80);
  });
});
