import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerAccounting,
  registerFirms,
  registerLocalEconomy,
} from '../../packages/simulation-core/src/index.js';

const accounting = {
  currency: { id: 'coin', unit: 'cent', scale: 0 },
  commodities: [
    { id: 'ore', unit: 'kg', scale: 0 },
    { id: 'metal', unit: 'bar', scale: 0 },
    { id: 'lumber', unit: 'board', scale: 0 },
  ],
  owners: ['owner-a', 'owner-b', 'workers', 'builder'],
  accounts: [
    { id: 'cash-a', ownerId: 'owner-a', openingBalance: 20 },
    { id: 'cash-b', ownerId: 'owner-b', openingBalance: 20 },
    { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
    { id: 'builder-cash', ownerId: 'builder', openingBalance: 0 },
  ],
  stock: [
    { ownerId: 'owner-a', commodity: 'ore', quantity: 3 },
    { ownerId: 'owner-b', commodity: 'ore', quantity: 5 },
  ],
  recipes: [
    {
      id: 'smelt',
      inputs: [{ commodity: 'ore', quantity: 1 }],
      outputs: [{ commodity: 'metal', quantity: 1 }],
    },
    {
      id: 'saw',
      inputs: [{ commodity: 'ore', quantity: 2 }],
      outputs: [{ commodity: 'lumber', quantity: 1 }],
    },
  ],
};
const producers = [
  {
    id: 'forge-a',
    cityId: 'north',
    ownerId: 'owner-a',
    accountId: 'cash-a',
    recipeId: 'smelt',
    laborPerBatch: 1,
    maxBatches: 1,
    wagePerBatch: 2,
  },
  {
    id: 'forge-b',
    cityId: 'south',
    ownerId: 'owner-b',
    accountId: 'cash-b',
    recipeId: 'saw',
    laborPerBatch: 1,
    maxBatches: 1,
    wagePerBatch: 2,
  },
];
const cohorts = [
  {
    id: 'workers-a',
    cityId: 'north',
    ownerId: 'workers',
    accountId: 'worker-cash',
    workersAvailable: 2,
    desiredNeeds: {},
  },
  {
    id: 'workers-b',
    cityId: 'south',
    ownerId: 'workers',
    accountId: 'worker-cash',
    workersAvailable: 2,
    desiredNeeds: {},
  },
];
function setup() {
  const engine = createEngine({ initialState: {} }, 7);
  registerLocalEconomy(engine, { ...accounting, producers, cohorts, sellers: [] });
  registerFirms(engine, {
    producers,
    constructionAccountId: 'builder-cash',
    expansionCostPerCapacity: 5,
  });
  return engine;
}

describe('independent firm lifecycle', () => {
  it('tracks each firm independently from its production and actual accounting journal', () => {
    const engine = setup();
    engine.run(2);
    const firms = engine.getState().domain.firms as {
      firms: Record<
        string,
        {
          cumulativeRevenue: number;
          cumulativeCost: number;
          employment: number;
          cityId: string;
          recipeId: string;
        }
      >;
    };
    expect(firms.firms['forge-a']).toMatchObject({
      cityId: 'north',
      employment: 1,
      cumulativeCost: 4,
    });
    expect(firms.firms['forge-b']).toMatchObject({
      cityId: 'south',
      recipeId: 'saw',
      employment: 1,
      cumulativeCost: 4,
    });
    const ledger = engine.getState().domain.accounting as {
      stock: Array<{ ownerId: string; commodity: string; location: string; quantity: number }>;
    };
    expect(ledger.stock).toContainEqual({
      ownerId: 'owner-a',
      commodity: 'metal',
      location: 'available',
      quantity: 2,
    });
    expect(ledger.stock).toContainEqual({
      ownerId: 'owner-b',
      commodity: 'lumber',
      location: 'available',
      quantity: 2,
    });
    expect(ledger.stock).toContainEqual({
      ownerId: 'owner-b',
      commodity: 'ore',
      location: 'available',
      quantity: 1,
    });
  });

  it('attributes sales from settled accounting payments and restores firm state deterministically', () => {
    const engine = createEngine({ initialState: {} }, 7);
    registerLocalEconomy(engine, {
      ...accounting,
      producers,
      cohorts: cohorts.map((c) => ({
        ...c,
        desiredNeeds: c.id === 'workers-a' ? { metal: 1 } : ({} as Record<string, number>),
      })),
      sellers: [
        {
          cityId: 'north',
          commodity: 'metal',
          ownerId: 'owner-a',
          accountId: 'cash-a',
          minPrice: 2,
          maxPrice: 2,
          openingPrice: 2,
        },
      ],
    });
    registerFirms(engine, {
      producers,
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    engine.step();
    const snapshot = engine.snapshot();
    const resumed = createEngine({ initialState: {} }, 7);
    registerLocalEconomy(resumed, {
      ...accounting,
      producers,
      cohorts: cohorts.map((c) => ({
        ...c,
        desiredNeeds: c.id === 'workers-a' ? { metal: 1 } : ({} as Record<string, number>),
      })),
      sellers: [
        {
          cityId: 'north',
          commodity: 'metal',
          ownerId: 'owner-a',
          accountId: 'cash-a',
          minPrice: 2,
          maxPrice: 2,
          openingPrice: 2,
        },
      ],
    });
    registerFirms(resumed, {
      producers,
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    resumed.restore(snapshot);
    expect(resumed.step()).toEqual(engine.step());
    const firms = engine.getState().domain.firms as {
      firms: Record<string, { revenueThisTick: number; cumulativeRevenue: number }>;
    };
    expect(firms.firms['forge-a']).toMatchObject({ revenueThisTick: 2, cumulativeRevenue: 4 });
  });

  it('applies an owner-authorized funded expansion on its requested tick only', () => {
    const engine = setup();
    engine.step();
    const expansion = {
      commandId: 'expand-a',
      requestedTick: 2,
      type: 'firm.expand',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', capacity: 1 },
    };
    engine.submit(expansion);
    engine.submit(expansion);
    const view = engine.step();
    const firms = view.domain.firms as { firms: Record<string, { capacity: number }> };
    const ledger = view.domain.accounting as { accounts: Array<{ id: string; balance: number }> };
    expect(firms.firms['forge-a']!.capacity).toBe(2);
    expect(firms.firms['forge-b']!.capacity).toBe(1);
    expect(firms.firms['forge-a']).toMatchObject({
      capitalOutlayThisTick: 5,
      cumulativeCapitalOutlay: 5,
      costThisTick: 4,
    });
    expect(ledger.accounts.find((a) => a.id === 'cash-a')!.balance).toBe(9);
    expect(ledger.accounts.find((a) => a.id === 'builder-cash')!.balance).toBe(5);
  });

  it('rejects unauthorized or unaffordable expansion without partial mutation and closes explicitly', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'bad-expand',
      requestedTick: 2,
      type: 'firm.expand',
      payload: { firmId: 'forge-a', ownerId: 'owner-b', capacity: 1 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'bad-expand')?.status).toBe('rejected');
    engine.submit({
      commandId: 'close-a',
      requestedTick: 3,
      type: 'firm.close',
      payload: { firmId: 'forge-a', ownerId: 'owner-a' },
    });
    engine.step();
    const firms = engine.getState().domain.firms as { firms: Record<string, { status: string }> };
    expect(firms.firms['forge-a']!.status).toBe('closed');
    const closedLedger = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      stock: Array<{ ownerId: string; commodity: string; quantity: number }>;
    };
    expect(closedLedger.accounts.find((a) => a.id === 'cash-a')!.balance).toBeGreaterThan(0);
    expect(
      closedLedger.stock.find((s) => s.ownerId === 'owner-a' && s.commodity === 'ore')!.quantity,
    ).toBeGreaterThan(0);
  });

  it('rejects insufficient expansion without capex or capacity mutation', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'unaffordable',
      requestedTick: 2,
      type: 'firm.expand',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', capacity: 100 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unaffordable')?.status).toBe('rejected');
    const view = engine.getState().domain;
    const firm = (
      view.firms as { firms: Record<string, { capacity: number; cumulativeCapitalOutlay: number }> }
    ).firms['forge-a']!;
    const ledger = view.accounting as { accounts: Array<{ id: string; balance: number }> };
    expect(firm).toMatchObject({ capacity: 1, cumulativeCapitalOutlay: 0 });
    expect(ledger.accounts.find((a) => a.id === 'builder-cash')!.balance).toBe(0);
  });

  it('closes after two consecutive wage-liquidity failures and retains owner assets', () => {
    const poor = { ...producers[0]!, wagePerBatch: 2 };
    const engine = createEngine({ initialState: {} }, 11);
    registerLocalEconomy(engine, {
      ...accounting,
      accounts: accounting.accounts.map((a) =>
        a.id === 'cash-a' ? { ...a, openingBalance: 1 } : a,
      ),
      producers: [poor],
      cohorts: [cohorts[0]!],
      sellers: [],
    });
    registerFirms(engine, {
      producers: [poor],
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    engine.step();
    expect(
      (
        engine.getState().domain.firms as {
          firms: Record<string, { status: string; insolvencyTicks: number }>;
        }
      ).firms['forge-a'],
    ).toMatchObject({ status: 'active', insolvencyTicks: 1 });
    engine.step();
    const firm = (
      engine.getState().domain.firms as {
        firms: Record<
          string,
          { status: string; insolvencyTicks: number; closureReason: string; closureTick: number }
        >;
      }
    ).firms['forge-a']!;
    expect(firm).toMatchObject({
      status: 'insolvent',
      insolvencyTicks: 2,
      closureReason: 'repeated-wage-liquidity-failure',
      closureTick: 2,
    });
    const ledger = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      stock: Array<{ ownerId: string; commodity: string; location: string; quantity: number }>;
    };
    expect(ledger.accounts.find((a) => a.id === 'cash-a')!.balance).toBe(1);
    expect(ledger.stock).toContainEqual({
      ownerId: 'owner-a',
      commodity: 'ore',
      location: 'available',
      quantity: 3,
    });
    registerAccounting(engine);
    engine.submit({
      commandId: 'post-closure-credit',
      requestedTick: 3,
      type: 'accounting.transaction',
      payload: {
        causeId: 'post-closure-credit',
        operations: [
          {
            type: 'payment',
            fromAccountId: 'cash-b',
            toAccountId: 'cash-a',
            amount: { kind: 'money', currencyId: 'coin', unit: 'cent', scale: 0, minor: 5 },
            causeId: 'post-closure-credit',
          },
        ],
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'post-closure-credit')?.status).toBe(
      'applied',
    );
    expect(
      (
        engine.getState().domain.economy as {
          producers: Record<string, { batches: number; stopped: string }>;
        }
      ).producers['forge-a']!.batches,
    ).toBe(0);
    expect(
      (engine.getState().domain.economy as { producers: Record<string, { stopped: string }> })
        .producers['forge-a']!.stopped,
    ).toBe('closed');
    expect(
      (engine.getState().domain.firms as { firms: Record<string, { employment: number }> }).firms[
        'forge-a'
      ]!.employment,
    ).toBe(0);
  });

  it('rejects duplicate or mismatched firm registrations without advancing a tick', () => {
    const duplicate = setup();
    expect(() =>
      registerFirms(duplicate, {
        producers: [
          { ...producers[0]!, ownerId: 'owner-a' },
          { ...producers[0]!, ownerId: 'owner-b', accountId: 'cash-b' },
        ],
        constructionAccountId: 'builder-cash',
        expansionCostPerCapacity: 5,
      }),
    ).toThrow(/duplicate firm ID/);
    const mismatch = createEngine({ initialState: {} }, 7);
    registerLocalEconomy(mismatch, { ...accounting, producers, cohorts, sellers: [] });
    registerFirms(mismatch, {
      producers: [{ ...producers[0]!, recipeId: 'saw' }, producers[1]!],
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    expect(() => mismatch.step()).toThrow(/invalid firm accounting references/);
    expect(mismatch.getState().tick).toBe(0);
    expect(mismatch.getState().domain).toEqual({});
  });
});
