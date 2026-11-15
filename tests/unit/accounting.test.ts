import { describe, expect, it } from 'vitest';

const money = (minor: number) => ({
  kind: 'money' as const,
  currencyId: 'coin',
  unit: 'cent',
  scale: 2,
  minor,
});
const qty = (quantity: number) => ({
  kind: 'commodity' as const,
  commodityId: 'grain',
  unit: 'kg',
  scale: 3,
  quantity,
});
import {
  applyAccountingTransaction,
  assertAccountingInvariant,
  createAccountingState,
} from '../../packages/simulation-core/src/services/accounting/index.js';

const opening = () =>
  createAccountingState({
    currency: { id: 'coin', unit: 'cent', scale: 2 },
    commodities: [{ id: 'grain', unit: 'kg', scale: 3 }],
    owners: ['alice', 'bob'],
    accounts: [
      { id: 'cash-a', ownerId: 'alice', openingBalance: 100 },
      { id: 'cash-b', ownerId: 'bob', openingBalance: 0 },
    ],
    stock: [{ ownerId: 'alice', commodity: 'grain', quantity: 20 }],
  });

describe('checked accounting state', () => {
  it('applies a payment and inventory transfer with causal journal entries', () => {
    const state = opening();
    const next = applyAccountingTransaction(
      state,
      [
        {
          type: 'payment',
          fromAccountId: 'cash-a',
          toAccountId: 'cash-b',
          amount: money(25),
          causeId: 'invoice-1',
        },
        {
          type: 'transfer',
          ownerId: 'alice',
          toOwnerId: 'bob',
          commodity: 'grain',
          quantity: qty(5),
          from: 'available',
          to: 'available',
          causeId: 'sale-1',
        },
      ],
      'trade-1',
    );
    expect(state.accounts.find((a) => a.id === 'cash-a')?.balance).toBe(100);
    expect(next.accounts.find((a) => a.id === 'cash-a')?.balance).toBe(75);
    expect(next.accounts.find((a) => a.id === 'cash-b')?.balance).toBe(25);
    expect(next.stock).toContainEqual({
      ownerId: 'bob',
      commodity: 'grain',
      location: 'available',
      quantity: 5,
    });
    expect(next.journal).toHaveLength(2);
    assertAccountingInvariant(next);
  });

  it('rolls back the complete transaction when a late operation fails', () => {
    const state = opening();
    const before = structuredClone(state);
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-b',
            amount: money(25),
            causeId: 'invoice-2',
          },
          {
            type: 'transfer',
            ownerId: 'alice',
            toOwnerId: 'bob',
            commodity: 'grain',
            quantity: qty(99),
            from: 'available',
            to: 'available',
            causeId: 'sale-2',
          },
        ],
        'failed-trade',
      ),
    ).toThrow(/insufficient/i);
    expect(state).toEqual(before);
  });

  it('reserves, departs and arrives without duplicating transit stock', () => {
    let state = opening();
    state = applyAccountingTransaction(
      state,
      [
        {
          type: 'reserve',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(7),
          reservationId: 'r1',
          causeId: 'order-1',
        },
      ],
      'reserve-1',
    );
    state = applyAccountingTransaction(
      state,
      [{ type: 'depart', reservationId: 'r1', shipmentId: 's1', causeId: 'ship-1' }],
      'depart-1',
    );
    expect(
      state.stock
        .filter((item) => item.commodity === 'grain')
        .reduce((sum, item) => sum + item.quantity, 0),
    ).toBe(20);
    expect(state.stock.find((item) => item.location === 'transit')?.quantity).toBe(7);
    state = applyAccountingTransaction(
      state,
      [{ type: 'arrive', shipmentId: 's1', toOwnerId: 'bob', causeId: 'arrival-1' }],
      'arrive-1',
    );
    expect(state.stock.some((item) => item.location === 'transit')).toBe(false);
    expect(
      state.stock.find((item) => item.ownerId === 'bob' && item.commodity === 'grain')?.quantity,
    ).toBe(7);
    assertAccountingInvariant(state);
  });

  it('applies declared recipes and losses with explicit provenance', () => {
    const state = createAccountingState({
      currency: { id: 'coin', unit: 'cent', scale: 2 },
      commodities: [
        { id: 'grain', unit: 'kg', scale: 3 },
        { id: 'flour', unit: 'kg', scale: 3 },
      ],
      recipes: [
        {
          id: 'mill',
          inputs: [{ commodity: 'grain', quantity: 3 }],
          outputs: [{ commodity: 'flour', quantity: 2 }],
        },
        {
          id: 'impossible',
          inputs: [{ commodity: 'grain', quantity: 6 }],
          outputs: [{ commodity: 'flour', quantity: 10 }],
        },
      ],
      owners: ['alice'],
      accounts: [{ id: 'cash', ownerId: 'alice', openingBalance: 0 }],
      stock: [{ ownerId: 'alice', commodity: 'grain', quantity: 5 }],
    });
    const next = applyAccountingTransaction(
      state,
      [
        {
          type: 'conversion',
          ownerId: 'alice',
          recipeId: 'mill',
          inputs: [{ commodity: 'grain', quantity: 3 }],
          outputs: [{ commodity: 'flour', quantity: 2 }],
          causeId: 'recipe-run',
        },
        {
          type: 'loss',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(1),
          causeId: 'spoilage',
          rationale: 'storage damage',
        },
      ],
      'production',
    );
    expect(next.stock).toContainEqual({
      ownerId: 'alice',
      commodity: 'grain',
      location: 'available',
      quantity: 1,
    });
    expect(next.stock).toContainEqual({
      ownerId: 'alice',
      commodity: 'flour',
      location: 'available',
      quantity: 2,
    });
    expect(next.journal[0]?.rationale).toBe('recipe:mill');
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'conversion',
            ownerId: 'alice',
            recipeId: 'ad-hoc',
            inputs: [{ commodity: 'grain', quantity: 1 }],
            outputs: [{ commodity: 'flour', quantity: 9 }],
            causeId: 'arbitrary',
          },
        ],
        'arbitrary',
      ),
    ).toThrow(/declared/i);
    expect(next.journal[1]?.rationale).toBe('storage damage');
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'conversion',
            ownerId: 'alice',
            recipeId: 'impossible',
            inputs: [{ commodity: 'grain', quantity: 6 }],
            outputs: [{ commodity: 'flour', quantity: 10 }],
            causeId: 'no-input',
          },
        ],
        'no-production',
      ),
    ).toThrow(/insufficient/i);
    expect(state.stock).toHaveLength(1);
  });

  it('rejects transfers into reserved stock without a reservation identifier', () => {
    expect(() =>
      applyAccountingTransaction(
        opening(),
        [
          {
            type: 'transfer',
            ownerId: 'alice',
            toOwnerId: 'bob',
            commodity: 'grain',
            quantity: qty(1),
            from: 'available',
            to: 'reserved',
            causeId: 'unreserved-hold',
          } as never,
        ],
        'unreserved-hold',
      ),
    ).toThrow(/reservationId/i);
  });

  it('rejects same-location minting, zero quantities and mismatched scales', () => {
    const state = opening();
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'transfer',
            ownerId: 'alice',
            toOwnerId: 'alice',
            commodity: 'grain',
            quantity: qty(1),
            from: 'available',
            to: 'available',
            causeId: 'x',
          },
        ],
        'same',
      ),
    ).toThrow();
    expect(() =>
      applyAccountingTransaction(
        state,
        [{ type: 'consume', ownerId: 'alice', commodity: 'grain', quantity: qty(0), causeId: 'x' }],
        'zero',
      ),
    ).toThrow();
    expect(() =>
      createAccountingState({
        currency: { id: 'coin', unit: 'cent', scale: 2 },
        commodities: [{ id: 'grain', unit: 'kg', scale: 3 }],
        owners: ['a'],
        accounts: [{ id: 'a', ownerId: 'a', openingBalance: 0 }],
        stock: [{ ownerId: 'a', commodity: 'grain', quantity: 1, scale: 2 }],
      }),
    ).toThrow(/scale/i);
  });

  it('registers atomically with createEngine and survives snapshot restore', async () => {
    const { createEngine, registerAccounting } =
      await import('../../packages/simulation-core/src/index.js');
    const initial = opening();
    const engine = createEngine({ initialState: { accounting: initial } }, 42);
    registerAccounting(engine);
    engine.submit({
      commandId: 'payment-command',
      requestedTick: 1,
      type: 'accounting.transaction',
      payload: {
        causeId: 'cmd',
        operations: [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-b',
            amount: money(10),
            causeId: 'invoice',
          },
        ],
      },
    });
    const restored = createEngine({ initialState: { accounting: initial } }, 42);
    registerAccounting(restored);
    restored.restore(engine.snapshot());
    restored.step();
    expect(
      (restored.getState().domain.accounting as ReturnType<typeof opening>).accounts.find(
        (account) => account.id === 'cash-a',
      )?.balance,
    ).toBe(90);
    const rejectEngine = createEngine({ initialState: { accounting: initial } }, 9);
    registerAccounting(rejectEngine);
    rejectEngine.submit({
      commandId: 'bad-payment',
      requestedTick: 1,
      type: 'accounting.transaction',
      payload: {
        causeId: 'bad',
        operations: [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-b',
            amount: money(10),
            causeId: 'invoice',
          },
          {
            type: 'transfer',
            ownerId: 'alice',
            toOwnerId: 'bob',
            commodity: 'grain',
            quantity: qty(999),
            from: 'available',
            to: 'available',
            causeId: 'sale',
          },
        ],
      },
    });
    const rngBefore = rejectEngine.snapshot().rngState;
    rejectEngine.step();
    expect(
      rejectEngine.receipts().find((receipt) => receipt.commandId === 'bad-payment')?.status,
    ).toBe('rejected');
    expect(rejectEngine.getState().domain.accounting).toEqual(initial);
    expect(rejectEngine.snapshot().rngState).toBe(rngBefore);
  });

  it('rejects overflow without changing either account', () => {
    const state = createAccountingState({
      currency: { id: 'coin', unit: 'cent', scale: 2 },
      commodities: [],
      owners: ['a', 'b'],
      accounts: [
        { id: 'a', ownerId: 'a', openingBalance: 1 },
        { id: 'b', ownerId: 'b', openingBalance: Number.MAX_SAFE_INTEGER },
      ],
    });
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'payment',
            fromAccountId: 'a',
            toAccountId: 'b',
            amount: money(1),
            causeId: 'overflow',
          },
        ],
        'overflow-tx',
      ),
    ).toThrow(/overflow|safe/i);
    expect(state.accounts.map((account) => account.balance)).toEqual([1, Number.MAX_SAFE_INTEGER]);
  });

  it('rejects bare numeric amounts and quantities at runtime', () => {
    const state = opening();
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-b',
            amount: 1,
            causeId: 'bare',
          } as never,
        ],
        'bare-money',
      ),
    ).toThrow(/value object/i);
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'consume',
            ownerId: 'alice',
            commodity: 'grain',
            quantity: 1,
            causeId: 'bare',
          } as never,
        ],
        'bare-quantity',
      ),
    ).toThrow(/value object/i);
  });

  it('rejects wrong money and commodity identity, unit, or scale', () => {
    const state = opening();
    for (const amount of [
      { ...money(1), currencyId: 'other' },
      { ...money(1), unit: 'dollar' },
      { ...money(1), scale: 0 },
    ])
      expect(() =>
        applyAccountingTransaction(
          state,
          [
            {
              type: 'payment',
              fromAccountId: 'cash-a',
              toAccountId: 'cash-b',
              amount,
              causeId: 'wrong',
            } as never,
          ],
          `wrong-money-${amount.currencyId}-${amount.unit}-${amount.scale}`,
        ),
      ).toThrow(/currency|unit|scale/i);
    for (const quantity of [
      { ...qty(1), commodityId: 'other' },
      { ...qty(1), unit: 'tonne' },
      { ...qty(1), scale: 0 },
    ])
      expect(() =>
        applyAccountingTransaction(
          state,
          [
            {
              type: 'consume',
              ownerId: 'alice',
              commodity: 'grain',
              quantity,
              causeId: 'wrong',
            } as never,
          ],
          `wrong-quantity-${quantity.commodityId}-${quantity.unit}-${quantity.scale}`,
        ),
      ).toThrow(/commodity|unit|scale/i);
  });

  it('rejects duplicate, zero, NaN, and overflowing opening stock', () => {
    const base = {
      currency: { id: 'coin', unit: 'cent', scale: 2 },
      commodities: [{ id: 'grain', unit: 'kg', scale: 3 }],
      owners: ['a'],
      accounts: [{ id: 'cash', ownerId: 'a', openingBalance: 0 }],
    };
    for (const stock of [
      [{ ownerId: 'a', commodity: 'grain', quantity: 0 }],
      [{ ownerId: 'a', commodity: 'grain', quantity: Number.NaN }],
      [{ ownerId: 'a', commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER + 1 }],
      [
        { ownerId: 'a', commodity: 'grain', quantity: 1 },
        { ownerId: 'a', commodity: 'grain', quantity: 2 },
      ],
    ])
      expect(() => createAccountingState({ ...base, stock })).toThrow();
  });

  it('accepts explicit money and commodity value objects', () => {
    const state = opening();
    const next = applyAccountingTransaction(
      state,
      [
        {
          type: 'payment',
          fromAccountId: 'cash-a',
          toAccountId: 'cash-b',
          amount: { kind: 'money', currencyId: 'coin', unit: 'cent', scale: 2, minor: 4 },
          causeId: 'typed-payment',
        },
        {
          type: 'consume',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: { kind: 'commodity', commodityId: 'grain', unit: 'kg', scale: 3, quantity: 2 },
          causeId: 'typed-use',
        },
      ],
      'typed-tx',
    );
    expect(next.accounts.map((account) => account.balance)).toEqual([96, 4]);
    expect(next.stock[0]?.quantity).toBe(18);
  });

  it('validates recipe definitions before accepting opening state', () => {
    expect(() =>
      createAccountingState({
        currency: { id: 'coin', unit: 'cent', scale: 2 },
        commodities: [{ id: 'grain', unit: 'kg', scale: 3 }],
        owners: ['alice'],
        accounts: [{ id: 'cash', ownerId: 'alice', openingBalance: 0 }],
        recipes: [
          {
            id: 'bad',
            inputs: [{ commodity: 'missing', quantity: 1 }],
            outputs: [{ commodity: 'grain', quantity: 1 }],
          },
        ],
      }),
    ).toThrow(/unknown commodity/i);
  });

  it('rejects payments with a mismatched currency identity', () => {
    const state = opening();
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-b',
            amount: { ...money(10), currencyId: 'other' },
            currencyId: 'other',
            unit: 'cent',
            scale: 2,
            causeId: 'wrong-currency',
          } as never,
        ],
        'wrong-currency',
      ),
    ).toThrow(/currency|unit|scale/i);
  });

  it('rejects self-payment without minting money', () => {
    const state = opening();
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'payment',
            fromAccountId: 'cash-a',
            toAccountId: 'cash-a',
            amount: money(10),
            causeId: 'self',
          },
        ],
        'self-tx',
      ),
    ).toThrow();
    expect(state.accounts.find((account) => account.id === 'cash-a')?.balance).toBe(100);
  });

  it('prevents shipment ID reuse even after the first shipment arrives', () => {
    let state = opening();
    state = applyAccountingTransaction(
      state,
      [
        {
          type: 'reserve',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(2),
          reservationId: 'r1',
          causeId: 'reserve',
        },
      ],
      'reserve',
    );
    state = applyAccountingTransaction(
      state,
      [{ type: 'depart', reservationId: 'r1', shipmentId: 'ship-unique', causeId: 'depart' }],
      'depart',
    );
    state = applyAccountingTransaction(
      state,
      [{ type: 'arrive', shipmentId: 'ship-unique', toOwnerId: 'bob', causeId: 'arrive' }],
      'arrive',
    );
    state = applyAccountingTransaction(
      state,
      [
        {
          type: 'reserve',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(2),
          reservationId: 'r2',
          causeId: 'reserve-again',
        },
      ],
      'reserve-again',
    );
    expect(() =>
      applyAccountingTransaction(
        state,
        [{ type: 'depart', reservationId: 'r2', shipmentId: 'ship-unique', causeId: 'reuse' }],
        'reuse',
      ),
    ).toThrow();
  });

  it('replays inventory journal against the opening stock baseline', () => {
    const state = opening();
    const paid = applyAccountingTransaction(
      state,
      [
        {
          type: 'consume',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(2),
          unit: 'kg',
          scale: 3,
          causeId: 'use',
        } as never,
      ],
      'consume-tx',
    );
    const tampered = structuredClone(paid);
    (tampered.stock[0] as { quantity: number }).quantity++;
    expect(() => assertAccountingInvariant(tampered)).toThrow(/stock|inventory|journal|reconcil/i);
  });

  it('prevents reservation ID reuse after release removes its stock row', () => {
    let state = opening();
    state = applyAccountingTransaction(
      state,
      [
        {
          type: 'reserve',
          ownerId: 'alice',
          commodity: 'grain',
          quantity: qty(1),
          reservationId: 'reused',
          causeId: 'reserve',
        },
      ],
      'reserve',
    );
    state = applyAccountingTransaction(
      state,
      [{ type: 'release', reservationId: 'reused', causeId: 'release' }],
      'release',
    );
    expect(state.stock.some((item) => item.reservationId === 'reused')).toBe(false);
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'reserve',
            ownerId: 'alice',
            commodity: 'grain',
            quantity: qty(1),
            reservationId: 'reused',
            causeId: 'again',
          },
        ],
        'again',
      ),
    ).toThrow(/reservation/i);
  });

  it('rejects invalid transfer locations and detects journal/account tampering', () => {
    const state = opening();
    expect(() =>
      applyAccountingTransaction(
        state,
        [
          {
            type: 'transfer',
            ownerId: 'alice',
            toOwnerId: 'bob',
            commodity: 'grain',
            quantity: qty(1),
            from: 'nonsense' as never,
            to: 'available',
            causeId: 'invalid',
          },
        ],
        'invalid',
      ),
    ).toThrow();
    const paid = applyAccountingTransaction(
      state,
      [
        {
          type: 'payment',
          fromAccountId: 'cash-a',
          toAccountId: 'cash-b',
          amount: money(1),
          causeId: 'payment',
        },
      ],
      'payment',
    );
    const tampered = structuredClone(paid);
    (tampered.accounts[0] as { balance: number }).balance--;
    expect(() => assertAccountingInvariant(tampered)).toThrow();
  });

  it('keeps payment rounding remainder with payer', () => {
    const state = opening();
    const next = applyAccountingTransaction(
      state,
      [
        {
          type: 'payment',
          fromAccountId: 'cash-a',
          toAccountId: 'cash-b',
          amount: money(10),
          causeId: 'bill',
        },
      ],
      'payment',
    );
    expect(next.accounts.find((a) => a.id === 'cash-a')?.balance).toBe(90);
    expect(next.accounts.find((a) => a.id === 'cash-b')?.balance).toBe(10);
  });
});
