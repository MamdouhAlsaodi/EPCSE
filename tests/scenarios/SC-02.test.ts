import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerCities,
  registerLocalEconomy,
} from '../../packages/simulation-core/src/index.js';

function run(capacity: number) {
  const config = {
    currency: { id: 'coin', unit: 'cent', scale: 0 },
    commodities: [
      { id: 'seed', unit: 'kg', scale: 0 },
      { id: 'grain', unit: 'kg', scale: 0 },
    ],
    owners: ['farm', 'households', 'carrier'],
    accounts: [
      { id: 'farm-cash', ownerId: 'farm', openingBalance: 1000 },
      { id: 'house-cash', ownerId: 'households', openingBalance: 1000 },
      { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
      { id: 'move-cash', ownerId: 'households', openingBalance: 0 },
    ],
    stock: [{ ownerId: 'farm', commodity: 'seed', quantity: 200 }],
    recipes: [
      {
        id: 'grow',
        inputs: [{ commodity: 'seed', quantity: 1 }],
        outputs: [{ commodity: 'grain', quantity: 1 }],
      },
    ],
    producers: [
      {
        id: 'farm',
        cityId: 'plain',
        ownerId: 'farm',
        accountId: 'farm-cash',
        recipeId: 'grow',
        laborPerBatch: 1,
        maxBatches: capacity,
        wagePerBatch: 1,
      },
    ],
    cohorts: [
      {
        id: 'rural',
        cityId: 'plain',
        ownerId: 'households',
        accountId: 'house-cash',
        workersAvailable: 0,
        desiredNeeds: { grain: 1 },
      },
    ],
    sellers: [
      {
        cityId: 'plain',
        commodity: 'grain',
        ownerId: 'farm',
        accountId: 'farm-cash',
        minPrice: 1,
        maxPrice: 4,
        openingPrice: 1,
      },
    ],
  };
  const engine = createEngine({ initialState: {} }, 31);
  registerLocalEconomy(engine, config);
  registerCities(engine, {
    cities: [{ id: 'plain', serviceCapacity: {}, serviceProvisionCost: 0 }],
    cohorts: [
      {
        id: 'rural',
        cityId: 'plain',
        population: 4,
        category: 'agriculture',
        class: 'low',
        skills: { farming: 1 },
        needs: { grain: 1 },
        incomePerPerson: 10,
        serviceNeeds: {},
        welfare: 80,
        linkedEconomyCohortId: 'rural',
      },
    ],
    routes: [],
    carrierAccountId: 'carrier-cash',
    migrationFundingAccountId: 'move-cash',
    migrationBudget: 0,
  });
  engine.run(30);
  return engine.getState().domain as {
    economy: {
      producers: Record<string, { batches: number }>;
      cohorts: Record<string, { cumulativeUnmet: Record<string, number> }>;
    };
    cities: { cohorts: Record<string, { welfare: number }> };
  };
}

describe('SC-02 agricultural capacity shock', () => {
  it('reduces real production and worsens unmet grain and welfare against the same-state baseline', () => {
    const baseline = run(5);
    const shock = run(3);
    expect(shock.economy.producers.farm!.batches).toBeLessThan(
      baseline.economy.producers.farm!.batches,
    );
    expect(shock.economy.cohorts.rural!.cumulativeUnmet.grain!).toBeGreaterThan(
      baseline.economy.cohorts.rural!.cumulativeUnmet.grain!,
    );
    expect(shock.cities.cohorts.rural!.welfare).toBeLessThan(
      baseline.cities.cohorts.rural!.welfare,
    );
  }, 15000);
});
