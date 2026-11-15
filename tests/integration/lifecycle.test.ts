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
  owners: ['owner-a', 'owner-b', 'owner-c', 'workers', 'builder'],
  accounts: [
    { id: 'cash-a', ownerId: 'owner-a', openingBalance: 20 },
    { id: 'cash-b', ownerId: 'owner-b', openingBalance: 20 },
    { id: 'cash-c', ownerId: 'owner-c', openingBalance: 20 },
    { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
    { id: 'builder-cash', ownerId: 'builder', openingBalance: 0 },
  ],
  stock: [
    { ownerId: 'owner-a', commodity: 'ore', quantity: 3 },
    { ownerId: 'owner-b', commodity: 'ore', quantity: 5 },
    { ownerId: 'owner-c', commodity: 'ore', quantity: 3 },
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
  {
    id: 'workers-c',
    cityId: 'east',
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
  it('builds a distinct owner-authorized firm with paid construction and live production', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'build-c',
      requestedTick: 2,
      type: 'firm.build',
      payload: {
        firmId: 'mill-c',
        ownerId: 'owner-c',
        accountId: 'cash-c',
        cityId: 'east',
        recipeId: 'smelt',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 1,
      },
    });
    const view = engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'build-c')?.status).toBe('applied');
    expect(
      (view.domain.firms as { firms: Record<string, { cityId: string }> }).firms['mill-c']?.cityId,
    ).toBe('east');
    expect(
      (view.domain.economy as { producers: Record<string, { batches: number }> }).producers[
        'mill-c'
      ]?.batches,
    ).toBe(1);
    expect(
      (
        view.domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts.find((a) => a.id === 'cash-c')?.balance,
    ).toBe(14);
  });

  it("restores a built firm's pending production deterministically with conserved ledger value", () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'build-c-restore',
      requestedTick: 2,
      type: 'firm.build',
      payload: {
        firmId: 'mill-c',
        ownerId: 'owner-c',
        accountId: 'cash-c',
        cityId: 'east',
        recipeId: 'smelt',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 1,
      },
    });
    engine.step();
    const snapshot = engine.snapshot();
    const resumed = setup();
    resumed.restore(snapshot);
    expect(resumed.step()).toEqual(engine.step());
    const ledger = engine.getState().domain.accounting as { accounts: Array<{ balance: number }> };
    expect(ledger.accounts.reduce((total, account) => total + account.balance, 0)).toBe(60);
  });

  it('rejects unauthorized and unaffordable establishment commands without changing balances or firms', () => {
    const engine = setup();
    engine.step();
    const before = engine.getState().domain;
    engine.submit({
      commandId: 'bad-build-owner',
      requestedTick: 2,
      type: 'firm.build',
      payload: {
        firmId: 'bad',
        ownerId: 'owner-a',
        accountId: 'cash-c',
        cityId: 'east',
        recipeId: 'smelt',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 0,
      },
    });
    engine.submit({ commandId: 'null-build', requestedTick: 2, type: 'firm.build', payload: null });
    engine.submit({
      commandId: 'poor-upgrade',
      requestedTick: 2,
      type: 'firm.upgrade',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', capacity: 100 },
    });
    const view = engine.step();
    expect(
      engine
        .receipts()
        .filter((r) => ['bad-build-owner', 'null-build', 'poor-upgrade'].includes(r.commandId))
        .every((r) => r.status === 'rejected'),
    ).toBe(true);
    expect(Object.keys((view.domain.firms as { firms: Record<string, unknown> }).firms)).toEqual([
      'forge-a',
      'forge-b',
    ]);
    expect(
      (
        view.domain.firms as {
          firms: Record<string, { capacity: number; cumulativeCapitalOutlay: number }>;
        }
      ).firms['forge-a'],
    ).toMatchObject({ capacity: 1, cumulativeCapitalOutlay: 0 });
    expect(
      (
        view.domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts.find((a) => a.id === 'builder-cash')?.balance,
    ).toBe(
      (before.accounting as { accounts: Array<{ id: string; balance: number }> }).accounts.find(
        (a) => a.id === 'builder-cash',
      )?.balance,
    );
  });

  it('applies upgrade, administration, and proposal-only relocation at their scheduled tick', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'upgrade-a',
      requestedTick: 2,
      type: 'firm.upgrade',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', capacity: 1 },
    });
    engine.submit({
      commandId: 'admin-a',
      requestedTick: 2,
      type: 'firm.administration',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', wagePerBatch: 3 },
    });
    engine.submit({
      commandId: 'relocate-a',
      requestedTick: 2,
      type: 'firm.relocation.propose',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', cityId: 'south' },
    });
    const view = engine.step();
    expect(
      engine
        .receipts()
        .filter((r) => ['upgrade-a', 'admin-a', 'relocate-a'].includes(r.commandId))
        .every((r) => r.status === 'applied'),
    ).toBe(true);
    expect(
      (
        view.domain.firms as {
          firms: Record<string, { capacity: number; cityId: string; relocationProposal: unknown }>;
        }
      ).firms['forge-a'],
    ).toMatchObject({
      capacity: 2,
      cityId: 'north',
      relocationProposal: { cityId: 'south', submittedTick: 2 },
    });
    expect(
      (view.domain.economy as { producers: Record<string, { wagePerBatch: number }> }).producers[
        'forge-a'
      ]?.wagePerBatch,
    ).toBe(3);
    expect(
      (view.domain.firms as { firms: Record<string, { costThisTick: number }> }).firms['forge-a']
        ?.costThisTick,
    ).toBe(6);
    expect(
      (
        view.domain.accounting as {
          stock: Array<{ ownerId: string; commodity: string; quantity: number }>;
        }
      ).stock.find((s) => s.ownerId === 'owner-a' && s.commodity === 'metal')?.quantity,
    ).toBe(3);
  });

  it('builds all requested capacity and charges per batch atomically', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'build-four',
      requestedTick: 2,
      type: 'firm.build',
      payload: {
        firmId: 'mill-four',
        ownerId: 'owner-c',
        accountId: 'cash-c',
        cityId: 'east',
        recipeId: 'smelt',
        laborPerBatch: 1,
        maxBatches: 4,
        wagePerBatch: 0,
      },
    });
    const view = engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'build-four')?.status).toBe('applied');
    expect(
      (
        view.domain.firms as {
          firms: Record<string, { capacity: number; cumulativeCapitalOutlay: number }>;
        }
      ).firms['mill-four'],
    ).toMatchObject({ capacity: 4, cumulativeCapitalOutlay: 20 });
    const accounts = (
      view.domain.accounting as { accounts: Array<{ id: string; balance: number }> }
    ).accounts;
    expect(accounts.find((a) => a.id === 'cash-c')?.balance).toBe(0);
    expect(accounts.find((a) => a.id === 'builder-cash')?.balance).toBe(20);
  });

  it('rejects unaffordable multi-batch builds and overflowing costs without partial mutation', () => {
    for (const [commandId, maxBatches, cost] of [
      ['build-poor', 5, 5],
      ['build-overflow', 2, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const engine = createEngine({ initialState: {} }, 7);
      registerLocalEconomy(engine, { ...accounting, producers, cohorts, sellers: [] });
      registerFirms(engine, {
        producers,
        constructionAccountId: 'builder-cash',
        expansionCostPerCapacity: cost,
      });
      engine.step();
      const before = engine.getState().domain;
      engine.submit({
        commandId,
        requestedTick: 2,
        type: 'firm.build',
        payload: {
          firmId: commandId,
          ownerId: 'owner-c',
          accountId: 'cash-c',
          cityId: 'east',
          recipeId: 'smelt',
          laborPerBatch: 1,
          maxBatches,
          wagePerBatch: 0,
        },
      });
      const view = engine.step();
      expect(engine.receipts().find((r) => r.commandId === commandId)?.status).toBe('rejected');
      expect(
        (view.domain.firms as { firms: Record<string, unknown> }).firms[commandId],
      ).toBeUndefined();
      expect(
        (view.domain.economy as { producers: Record<string, unknown> }).producers[commandId],
      ).toBeUndefined();
      const afterAccounts = (
        view.domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts;
      const beforeAccounts = (
        before.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts;
      for (const id of ['cash-c', 'builder-cash'])
        expect(afterAccounts.find((account) => account.id === id)?.balance).toBe(
          beforeAccounts.find((account) => account.id === id)?.balance,
        );
    }
  });

  it('applies a firm-specific seller price policy only from its scheduled tick', () => {
    const engine = createEngine({ initialState: {} }, 7);
    registerLocalEconomy(engine, {
      ...accounting,
      producers,
      cohorts,
      sellers: [
        {
          cityId: 'north',
          commodity: 'metal',
          ownerId: 'owner-a',
          accountId: 'cash-a',
          minPrice: 2,
          maxPrice: 4,
          openingPrice: 3,
        },
        {
          cityId: 'south',
          commodity: 'metal',
          ownerId: 'owner-b',
          accountId: 'cash-b',
          minPrice: 2,
          maxPrice: 4,
          openingPrice: 3,
        },
      ],
    });
    registerFirms(engine, {
      producers,
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    engine.step();
    engine.submit({
      commandId: 'price-a',
      requestedTick: 2,
      type: 'firm.price',
      payload: {
        firmId: 'forge-a',
        ownerId: 'owner-a',
        commodity: 'metal',
        minPrice: 8,
        maxPrice: 8,
        openingPrice: 8,
      },
    });
    const view = engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'price-a')?.status).toBe('applied');
    expect(
      (view.domain.economy as { sellers: Record<string, { minPrice: number; price: number }> })
        .sellers['["north","metal"]'],
    ).toMatchObject({ minPrice: 8, price: 8 });
    expect(
      (view.domain.economy as { sellers: Record<string, { minPrice: number; price: number }> })
        .sellers['["south","metal"]'],
    ).toMatchObject({ minPrice: 2, price: 3 });
  });

  it('rejects price changes for missing or wrong-identity sellers in the firm city', () => {
    for (const seller of [
      {
        cityId: 'south',
        commodity: 'metal',
        ownerId: 'owner-a',
        accountId: 'cash-a',
        minPrice: 2,
        maxPrice: 4,
        openingPrice: 3,
      },
      {
        cityId: 'north',
        commodity: 'metal',
        ownerId: 'owner-b',
        accountId: 'cash-b',
        minPrice: 2,
        maxPrice: 4,
        openingPrice: 3,
      },
    ]) {
      const engine = createEngine({ initialState: {} }, 7);
      registerLocalEconomy(engine, { ...accounting, producers, cohorts, sellers: [seller] });
      registerFirms(engine, {
        producers,
        constructionAccountId: 'builder-cash',
        expansionCostPerCapacity: 5,
      });
      engine.step();
      engine.submit({
        commandId: 'bad-price',
        requestedTick: 2,
        type: 'firm.price',
        payload: {
          firmId: 'forge-a',
          ownerId: 'owner-a',
          commodity: 'metal',
          minPrice: 8,
          maxPrice: 8,
          openingPrice: 8,
        },
      });
      engine.step();
      expect(engine.receipts().find((r) => r.commandId === 'bad-price')?.status).toBe('rejected');
      expect(
        (
          engine.getState().domain.economy as {
            sellers: Record<string, { minPrice: number; price: number }>;
          }
        ).sellers[JSON.stringify([seller.cityId, seller.commodity])],
      ).toMatchObject({ minPrice: 2, price: 3 });
    }
  });

  it('rejects unknown relocation destinations without changing firm state', () => {
    const engine = setup();
    engine.step();
    engine.submit({
      commandId: 'unknown-city',
      requestedTick: 2,
      type: 'firm.relocation.propose',
      payload: {
        firmId: 'forge-a',
        ownerId: 'owner-a',
        cityId: 'not-registered',
      },
    });
    const view = engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unknown-city')?.status).toBe('rejected');
    expect(
      (
        view.domain.firms as {
          firms: Record<string, { cityId: string; relocationProposal?: unknown }>;
        }
      ).firms['forge-a'],
    ).toMatchObject({ cityId: 'north' });
    expect(
      (view.domain.firms as { firms: Record<string, { relocationProposal?: unknown }> }).firms[
        'forge-a'
      ]?.relocationProposal,
    ).toBeUndefined();
  });

  it('does not apply build, price, or relocation before requestedTick and duplicate command IDs apply once', () => {
    const engine = createEngine({ initialState: {} }, 7);
    registerLocalEconomy(engine, {
      ...accounting,
      producers,
      cohorts,
      sellers: [
        {
          cityId: 'north',
          commodity: 'metal',
          ownerId: 'owner-a',
          accountId: 'cash-a',
          minPrice: 2,
          maxPrice: 4,
          openingPrice: 3,
        },
      ],
    });
    registerFirms(engine, {
      producers,
      constructionAccountId: 'builder-cash',
      expansionCostPerCapacity: 5,
    });
    engine.step();
    const build = {
      commandId: 'future-build',
      requestedTick: 3,
      type: 'firm.build',
      payload: {
        firmId: 'future-mill',
        ownerId: 'owner-c',
        accountId: 'cash-c',
        cityId: 'east',
        recipeId: 'smelt',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 0,
      },
    };
    engine.submit(build);
    engine.submit(build);
    engine.submit({
      commandId: 'future-price',
      requestedTick: 3,
      type: 'firm.price',
      payload: {
        firmId: 'forge-a',
        ownerId: 'owner-a',
        commodity: 'metal',
        minPrice: 8,
        maxPrice: 8,
        openingPrice: 8,
      },
    });
    engine.submit({
      commandId: 'future-relocation',
      requestedTick: 3,
      type: 'firm.relocation.propose',
      payload: { firmId: 'forge-a', ownerId: 'owner-a', cityId: 'south' },
    });
    engine.step();
    const early = engine.getState().domain;
    expect(
      engine
        .receipts()
        .filter((r) => ['future-build', 'future-price', 'future-relocation'].includes(r.commandId))
        .every((r) => r.status === 'queued'),
    ).toBe(true);
    expect(
      (early.firms as { firms: Record<string, unknown> }).firms['future-mill'],
    ).toBeUndefined();
    expect(
      (early.economy as { sellers: Record<string, { minPrice: number }> }).sellers[
        '["north","metal"]'
      ]?.minPrice,
    ).toBe(2);
    expect(
      (early.firms as { firms: Record<string, { relocationProposal?: unknown }> }).firms['forge-a']
        ?.relocationProposal,
    ).toBeUndefined();
    engine.step();
    const applied = engine.getState().domain;
    expect(
      engine
        .receipts()
        .filter((r) => ['future-build', 'future-price', 'future-relocation'].includes(r.commandId))
        .every((r) => r.status === 'applied'),
    ).toBe(true);
    expect(
      (applied.firms as { firms: Record<string, { cumulativeCapitalOutlay: number }> }).firms[
        'future-mill'
      ]?.cumulativeCapitalOutlay,
    ).toBe(5);
    expect(
      (applied.economy as { sellers: Record<string, { minPrice: number }> }).sellers[
        '["north","metal"]'
      ]?.minPrice,
    ).toBe(8);
    expect(
      (
        applied.firms as {
          firms: Record<string, { cityId: string; relocationProposal: { cityId: string } }>;
        }
      ).firms['forge-a'],
    ).toMatchObject({ cityId: 'north', relocationProposal: { cityId: 'south' } });
  });

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
