import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerLocalEconomy,
  registerPolitics,
} from '../../packages/simulation-core/src/index.js';

describe('SC-05 social action', () => {
  it('reduces actual production and paid wages under organized pressure, not price-only pressure', () => {
    const run = (organization: number) => {
      const engine = createEngine({ initialState: {} }, 7);
      registerLocalEconomy(engine, {
        currency: { id: 'coin', unit: 'cent', scale: 0 },
        commodities: [
          { id: 'ore', unit: 'unit', scale: 0 },
          { id: 'iron', unit: 'unit', scale: 0 },
        ],
        owners: ['mine', 'workers'],
        accounts: [
          { id: 'mine-cash', ownerId: 'mine', openingBalance: 100 },
          { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
        ],
        stock: [{ ownerId: 'mine', commodity: 'ore', quantity: 20 }],
        recipes: [
          {
            id: 'smelt',
            inputs: [{ commodity: 'ore', quantity: 1 }],
            outputs: [{ commodity: 'iron', quantity: 1 }],
          },
        ],
        producers: [
          {
            id: 'mine',
            cityId: 'town',
            ownerId: 'mine',
            accountId: 'mine-cash',
            recipeId: 'smelt',
            laborPerBatch: 1,
            maxBatches: 10,
            wagePerBatch: 1,
          },
        ],
        cohorts: [
          {
            id: 'workers',
            cityId: 'town',
            ownerId: 'workers',
            accountId: 'worker-cash',
            workersAvailable: 10,
            desiredNeeds: {},
          },
        ],
        sellers: [],
      });
      registerPolitics(engine, {
        groups: [
          {
            id: 'miners',
            producerIds: ['mine'],
            cohortId: 'workers',
            organization,
            resources: 20,
            realWageBps: 7000,
            unemploymentBps: 2000,
            satisfaction: 20,
            demand: { wageIncreaseBps: 1000 },
            participationBps: 8000,
            recoveryTicks: 3,
            durationTicks: 5,
          },
        ],
        producers: [{ id: 'mine' }],
      });
      engine.step();
      const domain = engine.step().domain;
      const economy = domain.economy as { producers: Record<string, { batches: number }> };
      const accounting = domain.accounting as { accounts: Array<{ id: string; balance: number }> };
      return {
        batches: economy.producers.mine!.batches,
        wages: accounting.accounts.find((a) => a.id === 'worker-cash')!.balance,
        politics: domain.politics as { actions: unknown[] },
      };
    };
    const baseline = run(0),
      strike = run(80);
    expect(strike.batches).toBeLessThan(baseline.batches);
    expect(strike.wages).toBeLessThan(baseline.wages);
    expect(baseline.politics.actions).toHaveLength(0);
  });
  it('rejects high-bound political wage arithmetic without unsafe Number conversion', () => {
    const engine = createEngine({ initialState: {} }, 8);
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'cent', scale: 0 },
      commodities: [{ id: 'ore', unit: 'unit', scale: 0 }],
      owners: ['mine', 'workers'],
      accounts: [
        { id: 'mine-cash', ownerId: 'mine', openingBalance: Number.MAX_SAFE_INTEGER },
        { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'mine', commodity: 'ore', quantity: 1 }],
      recipes: [
        {
          id: 'mine-ore',
          inputs: [{ commodity: 'ore', quantity: 1 }],
          outputs: [{ commodity: 'ore', quantity: 1 }],
        },
      ],
      producers: [
        {
          id: 'mine',
          cityId: 'town',
          ownerId: 'mine',
          accountId: 'mine-cash',
          recipeId: 'mine-ore',
          laborPerBatch: 1,
          maxBatches: 0,
          wagePerBatch: Number.MAX_SAFE_INTEGER,
        },
      ],
      cohorts: [
        {
          id: 'workers',
          cityId: 'town',
          ownerId: 'workers',
          accountId: 'worker-cash',
          workersAvailable: 1,
          desiredNeeds: {},
        },
      ],
      sellers: [],
    });
    registerPolitics(engine, {
      groups: [
        {
          id: 'miners',
          producerIds: ['mine'],
          cohortId: 'workers',
          organization: 80,
          resources: 20,
          realWageBps: 7000,
          unemploymentBps: 2000,
          satisfaction: 20,
          demand: { wageIncreaseBps: 10000 },
          participationBps: 5000,
          recoveryTicks: 1,
          durationTicks: 5,
          employerAcceptanceBps: 10000,
          employerAccountId: 'mine-cash',
          workerAccountId: 'worker-cash',
          employerOwnerId: 'mine',
          workerOwnerId: 'workers',
        },
      ],
      producers: [{ id: 'mine' }],
    });
    engine.run(2);
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'high-wage',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 1, wageIncreaseBps: 10000 },
    });
    engine.step();
    engine.step();
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow(RangeError);
    expect(engine.snapshotText()).toBe(before);
  });
});
