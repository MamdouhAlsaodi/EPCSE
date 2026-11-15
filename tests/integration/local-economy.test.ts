import { describe, expect, it } from 'vitest';
import { createEngine, registerLocalEconomy } from '../../packages/simulation-core/src/index.js';

const config = {
  currency: { id: 'coin', unit: 'cent', scale: 0 },
  commodities: [
    { id: 'grain', unit: 'kg', scale: 0 },
    { id: 'bread', unit: 'loaf', scale: 0 },
  ],
  owners: ['mill', 'bakery', 'households'],
  accounts: [
    { id: 'mill-cash', ownerId: 'mill', openingBalance: 0 },
    { id: 'bakery-cash', ownerId: 'bakery', openingBalance: 100 },
    { id: 'house-cash', ownerId: 'households', openingBalance: 100 },
  ],
  stock: [{ ownerId: 'bakery', commodity: 'grain', quantity: 2 }],
  recipes: [
    {
      id: 'bake',
      inputs: [{ commodity: 'grain', quantity: 1 }],
      outputs: [{ commodity: 'bread', quantity: 1 }],
    },
  ],
  producers: [
    {
      id: 'bakery',
      cityId: 'town',
      ownerId: 'bakery',
      accountId: 'bakery-cash',
      recipeId: 'bake',
      laborPerBatch: 1,
      maxBatches: 2,
      wagePerBatch: 2,
    },
  ],
  cohorts: [
    {
      id: 'families',
      cityId: 'town',
      ownerId: 'households',
      accountId: 'house-cash',
      workersAvailable: 2,
      desiredNeeds: { bread: 1 },
    },
  ],
  sellers: [
    {
      cityId: 'town',
      commodity: 'bread',
      ownerId: 'bakery',
      accountId: 'bakery-cash',
      minPrice: 1,
      maxPrice: 10,
      openingPrice: 2,
    },
  ],
};

describe('local economy', () => {
  it('keeps proportional floor wage remainder with the paying producer', () => {
    const multiCohort = {
      ...config,
      accounts: [
        ...config.accounts,
        { id: 'second-cash', ownerId: 'second-households', openingBalance: 0 },
      ],
      owners: [...config.owners, 'second-households'],
      cohorts: [
        { ...config.cohorts[0]!, workersAvailable: 1, desiredNeeds: {} },
        {
          id: 'second',
          cityId: 'town',
          ownerId: 'second-households',
          accountId: 'second-cash',
          workersAvailable: 2,
          desiredNeeds: {},
        },
      ],
      producers: [{ ...config.producers[0]!, laborPerBatch: 3, wagePerBatch: 2, maxBatches: 1 }],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, multiCohort);
    const state = engine.step().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
    };
    expect(state.accounts.find((entry) => entry.id === 'house-cash')?.balance).toBe(100);
    expect(state.accounts.find((entry) => entry.id === 'second-cash')?.balance).toBe(1);
    expect(state.accounts.find((entry) => entry.id === 'bakery-cash')?.balance).toBe(99);
  });

  it('accumulates unmet need and records a reason when no seller is configured', () => {
    const noSeller = { ...config, sellers: [] };
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, noSeller);
    engine.run(2);
    const economy = engine.getState().domain.economy as {
      cohorts: Record<
        string,
        {
          unmet: Record<string, number>;
          cumulativeUnmet: Record<string, number>;
          reasons?: Record<string, string>;
        }
      >;
    };
    expect(economy.cohorts.families!.unmet.bread).toBe(1);
    expect(economy.cohorts.families!.cumulativeUnmet.bread).toBe(2);
    expect(economy.cohorts.families!.reasons?.bread).toBe('no-seller');
  });

  it('allocates each producer to remaining same-city workers and pays the cohorts employed', () => {
    const multiProducer = {
      ...config,
      owners: [...config.owners, 'second-mill', 'worker-two'],
      accounts: [
        ...config.accounts,
        { id: 'second-mill-cash', ownerId: 'second-mill', openingBalance: 100 },
        { id: 'worker-two-cash', ownerId: 'worker-two', openingBalance: 0 },
      ],
      stock: [...config.stock, { ownerId: 'second-mill', commodity: 'grain', quantity: 1 }],
      producers: [
        { ...config.producers[0]!, maxBatches: 1 },
        {
          ...config.producers[0]!,
          id: 'second-producer',
          ownerId: 'second-mill',
          accountId: 'second-mill-cash',
          maxBatches: 1,
        },
      ],
      cohorts: [
        { ...config.cohorts[0]!, id: 'worker-one', workersAvailable: 1, desiredNeeds: {} },
        {
          ...config.cohorts[0]!,
          id: 'worker-two',
          ownerId: 'worker-two',
          accountId: 'worker-two-cash',
          workersAvailable: 1,
          desiredNeeds: {},
        },
      ],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, multiProducer);
    const accounts = engine.step().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
    };
    expect(accounts.accounts.find((x) => x.id === 'house-cash')?.balance).toBe(102);
    expect(accounts.accounts.find((x) => x.id === 'worker-two-cash')?.balance).toBe(2);
  });

  it('rejects self-payments at economy configuration validation', () => {
    const selfWage = {
      ...config,
      producers: [{ ...config.producers[0]!, ownerId: 'households', accountId: 'house-cash' }],
    };
    const engine = createEngine({ initialState: {} }, 1);
    expect(() => registerLocalEconomy(engine, selfWage)).toThrow(/self|same account/i);
    const selfTrade = {
      ...config,
      sellers: [{ ...config.sellers[0]!, ownerId: 'households', accountId: 'house-cash' }],
    };
    expect(() => registerLocalEconomy(createEngine({ initialState: {} }, 1), selfTrade)).toThrow(
      /self|same account/i,
    );
  });

  it('rejects duplicate IDs and unknown ledger references before ticking', () => {
    const duplicate = { ...config, producers: [config.producers[0]!, config.producers[0]!] };
    expect(() => registerLocalEconomy(createEngine({ initialState: {} }, 1), duplicate)).toThrow(
      /duplicate producer/i,
    );
    const unknownRecipe = {
      ...config,
      producers: [{ ...config.producers[0]!, recipeId: 'missing-recipe' }],
    };
    expect(() =>
      registerLocalEconomy(createEngine({ initialState: {} }, 1), unknownRecipe),
    ).toThrow(/references/i);
  });

  it('rejects paid production with no same-city worker account', () => {
    const noWorkers = { ...config, cohorts: [] };
    const engine = createEngine({ initialState: {} }, 1);
    expect(() => registerLocalEconomy(engine, noWorkers)).toThrow(/wage|cohort/i);
  });

  it('reports blocked production and settlement causes without phantom money or stock', () => {
    const blocked = {
      ...config,
      accounts: config.accounts
        .map((x) => (x.id === 'bakery-cash' ? { ...x, openingBalance: 0 } : x))
        .map((x) => (x.id === 'house-cash' ? { ...x, openingBalance: 0 } : x)),
      stock: [],
      producers: [{ ...config.producers[0]!, maxBatches: 1 }],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, blocked);
    const state = engine.step().domain;
    const economy = state.economy as {
      producers: Record<string, { stopped: string | null }>;
      cohorts: Record<string, { unmet: Record<string, number>; reasons?: Record<string, string> }>;
    };
    expect(economy.producers.bakery!.stopped).toBe('missing-inputs');
    expect(economy.cohorts.families!.reasons?.bread).toBe('empty-supply');
    expect((state.accounting as { journal: unknown[] }).journal).toHaveLength(0);
  });

  it('distinguishes zero workers and zero producer liquidity without transactions', () => {
    const noWorkers = {
      ...config,
      producers: [{ ...config.producers[0]!, maxBatches: 1 }],
      cohorts: [{ ...config.cohorts[0]!, workersAvailable: 0 }],
    };
    const workerEngine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(workerEngine, noWorkers);
    expect(
      (workerEngine.step().domain.economy as { producers: Record<string, { stopped: string }> })
        .producers.bakery!.stopped,
    ).toBe('no-workers');

    const noLiquidity = {
      ...config,
      accounts: config.accounts.map((x) =>
        x.id === 'bakery-cash' ? { ...x, openingBalance: 0 } : x,
      ),
    };
    const cashEngine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(cashEngine, noLiquidity);
    const view = cashEngine.step().domain;
    expect(
      (view.economy as { producers: Record<string, { stopped: string }> }).producers.bakery!
        .stopped,
    ).toBe('no-liquidity');
    expect((view.accounting as { journal: unknown[] }).journal).toHaveLength(0);
  });

  it('produces, quotes once, settles paid consumption, and tracks unmet needs deterministically', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, config);
    const view = engine.step();
    const economy = view.domain.economy as {
      cohorts: Record<
        string,
        { unmet: Record<string, number>; cumulativeUnmet: Record<string, number> }
      >;
    };
    const accounting = view.domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      stock: Array<{ ownerId: string; commodity: string; quantity: number }>;
    };
    expect(economy.cohorts.families!.unmet.bread).toBe(0);
    expect(economy.cohorts.families!.cumulativeUnmet.bread).toBe(0);
    expect(accounting.accounts.find((account) => account.id === 'house-cash')?.balance).toBe(102);
    expect(accounting.accounts.reduce((total, account) => total + account.balance, 0)).toBe(200);
    expect(
      accounting.stock.find((item) => item.ownerId === 'households' && item.commodity === 'bread')
        ?.quantity,
    ).toBeUndefined();
    expect(
      (view.domain.economy as { quotes: Record<string, { price: number }> }).quotes[
        '["town","bread"]'
      ]!.price,
    ).toBeGreaterThan(0);
    expect((view.domain.accounting as { journal: unknown[] }).journal).toHaveLength(7);
    expect(
      (view.domain.accounting as { journal: Array<{ type: string }> }).journal.filter(
        (entry) => entry.type === 'consume',
      ),
    ).toHaveLength(1);
    const restored = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(restored, config);
    restored.restore(engine.snapshot());
    expect(restored.step()).toEqual(engine.step());
  });

  it('rejects a snapshot from another registered economy config without partial restore', () => {
    const source = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(source, config);
    source.step();

    const target = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(target, {
      ...config,
      cohorts: [{ ...config.cohorts[0]!, workersAvailable: 3 }],
    });
    target.step();
    const before = target.snapshotText();
    expect(() => target.restore(source.snapshot())).toThrow(/config|economy|snapshot/i);
    expect(target.snapshotText()).toBe(before);
  });

  it('rolls back production wages and purchases when cumulative unmet overflows late in settlement', () => {
    const overflowing = {
      ...config,
      stock: [{ ownerId: 'bakery', commodity: 'grain', quantity: 2 }],
      cohorts: [{ ...config.cohorts[0]!, desiredNeeds: { bread: Number.MAX_SAFE_INTEGER } }],
      producers: [{ ...config.producers[0]!, maxBatches: 1 }],
    };
    const engine = createEngine({ initialState: {} }, 9);
    registerLocalEconomy(engine, overflowing);
    engine.step();
    const before = engine.snapshot();
    expect(() => engine.step()).toThrow(/overflow/i);
    expect(engine.snapshot()).toEqual(before);
  });

  it('a 40% capacity shock reduces output and increases cumulative unmet need', () => {
    const baselineConfig = {
      ...config,
      stock: [{ ownerId: 'bakery', commodity: 'grain', quantity: 10 }],
      cohorts: [{ ...config.cohorts[0]!, workersAvailable: 5, desiredNeeds: { bread: 5 } }],
      producers: [{ ...config.producers[0]!, maxBatches: 5 }],
    };
    const shockConfig = {
      ...baselineConfig,
      producers: [{ ...baselineConfig.producers[0]!, maxBatches: 3 }],
    };
    const baseline = createEngine({ initialState: {} }, 5);
    const shock = createEngine({ initialState: {} }, 5);
    registerLocalEconomy(baseline, baselineConfig);
    registerLocalEconomy(shock, shockConfig);
    baseline.run(2);
    shock.run(2);
    const baselineView = baseline.getState().domain as {
      economy: {
        producers: Record<string, { batches: number }>;
        cohorts: Record<string, { cumulativeUnmet: Record<string, number> }>;
      };
    };
    const shockView = shock.getState().domain as typeof baselineView;
    expect(shockView.economy.producers.bakery!.batches).toBeLessThan(
      baselineView.economy.producers.bakery!.batches,
    );
    expect(shockView.economy.cohorts.families!.cumulativeUnmet.bread!).toBeGreaterThan(
      baselineView.economy.cohorts.families!.cumulativeUnmet.bread!,
    );
  });
});
