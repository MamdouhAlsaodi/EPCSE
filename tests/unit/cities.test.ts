import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerCities,
  registerLocalEconomy,
  type CityConfig,
  type LocalEconomyConfig,
} from '../../packages/simulation-core/src/index.js';

const economy: LocalEconomyConfig = {
  currency: { id: 'coin', unit: 'cent', scale: 0 },
  commodities: [{ id: 'grain', unit: 'kg', scale: 0 }],
  owners: ['households', 'farm'],
  accounts: [
    { id: 'house-cash', ownerId: 'households', openingBalance: 0 },
    { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
    { id: 'carrier-cash', ownerId: 'farm', openingBalance: 100 },
    { id: 'migration-fund', ownerId: 'households', openingBalance: 20 },
  ],
  cohorts: [
    {
      id: 'rural',
      cityId: 'source',
      ownerId: 'households',
      accountId: 'house-cash',
      workersAvailable: 0,
      desiredNeeds: { grain: 1 },
    },
  ],
  producers: [],
  sellers: [
    {
      cityId: 'source',
      commodity: 'grain',
      ownerId: 'farm',
      accountId: 'farm-cash',
      minPrice: 1,
      maxPrice: 4,
      openingPrice: 2,
    },
  ],
  stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 100 }],
};

const cities: CityConfig = {
  cities: [
    { id: 'source', serviceCapacity: { care: 0 }, serviceProvisionCost: 0 },
    { id: 'destination', serviceCapacity: { care: 4 }, serviceProvisionCost: 0 },
  ],
  cohorts: [
    {
      id: 'rural',
      cityId: 'source',
      population: 4,
      category: 'agriculture',
      class: 'low',
      skills: { farming: 2 },
      needs: { grain: 1 },
      incomePerPerson: 0,
      serviceNeeds: { care: 1 },
      welfare: 100,
      linkedEconomyCohortId: 'rural',
    },
  ],
  routes: [{ fromCityId: 'source', toCityId: 'destination', costPerPerson: 2 }],
  carrierAccountId: 'carrier-cash',
  migrationFundingAccountId: 'migration-fund',
  migrationBudget: 8,
};

function configured(cityConfig = cities) {
  const engine = createEngine({ initialState: {} }, 17);
  registerLocalEconomy(engine, economy);
  registerCities(engine, cityConfig);
  return engine;
}

describe('city cohorts integrated with local economy', () => {
  it('does not migrate without a compatible destination cohort', () => {
    const engine = configured();
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { population: number; cityId: string }>;
      migration: Array<{
        fromCohortId: string;
        toCohortId: string;
        fromCityId: string;
        toCityId: string;
        population: number;
        cost: number;
      }>;
    };
    expect(state.cohorts.rural).toMatchObject({ population: 4, cityId: 'source' });
    expect(state.migration).toEqual([]);
    const ledger = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
    };
    expect(ledger.accounts.find((a) => a.id === 'carrier-cash')?.balance).toBe(100);
    expect(ledger.accounts.find((a) => a.id === 'migration-fund')?.balance).toBe(20);
  });

  it('moves only the people covered by migration funding into a compatible destination cohort', () => {
    const config: CityConfig = {
      ...cities,
      cohorts: [
        ...cities.cohorts,
        {
          ...cities.cohorts[0]!,
          id: 'urban',
          cityId: 'destination',
          population: 0,
          linkedEconomyCohortId: 'urban',
        },
      ],
      migrationBudget: 4,
    };
    const engine = createEngine({ initialState: {} }, 17);
    registerLocalEconomy(engine, {
      ...economy,
      owners: [...economy.owners, 'urban-households'],
      accounts: [
        ...economy.accounts,
        { id: 'urban-cash', ownerId: 'urban-households', openingBalance: 0 },
      ],
      cohorts: [
        ...economy.cohorts,
        {
          ...economy.cohorts[0]!,
          id: 'urban',
          cityId: 'destination',
          ownerId: 'urban-households',
          accountId: 'urban-cash',
        },
      ],
    });
    registerCities(engine, config);
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { population: number; cityId: string }>;
      migration: Array<{
        fromCohortId: string;
        toCohortId: string;
        population: number;
        cost: number;
      }>;
    };
    expect(state.cohorts.rural).toMatchObject({ population: 2, cityId: 'source' });
    expect(state.cohorts.urban).toMatchObject({ population: 2, cityId: 'destination' });
    expect(state.cohorts.rural!.population + state.cohorts.urban!.population).toBe(4);
    expect(state.migration).toEqual([
      {
        fromCohortId: 'rural',
        toCohortId: 'urban',
        fromCityId: 'source',
        toCityId: 'destination',
        population: 2,
        cost: 4,
        tick: 1,
      },
    ]);
  });

  it('shares finite service capacity across city cohorts in deterministic order', () => {
    const config: CityConfig = {
      ...cities,
      cohorts: [
        { ...cities.cohorts[0]!, id: 'first', linkedEconomyCohortId: 'rural' },
        { ...cities.cohorts[0]!, id: 'second', linkedEconomyCohortId: 'second' },
      ],
      cities: [{ ...cities.cities[0]!, serviceCapacity: { care: 4 } }, cities.cities[1]!],
      routes: [],
    };
    const engine = createEngine({ initialState: {} }, 17);
    registerLocalEconomy(engine, {
      ...economy,
      cohorts: [...economy.cohorts, { ...economy.cohorts[0]!, id: 'second' }],
    });
    registerCities(engine, config);
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { serviceCoverage: Record<string, number> }>;
    };
    expect(state.cohorts.first!.serviceCoverage.care).toBe(100);
    expect(state.cohorts.second!.serviceCoverage.care).toBe(0);
  });

  it('uses explicit separate category and class need weights', () => {
    const config: CityConfig = {
      ...cities,
      routes: [],
      categoryNeedWeights: { agriculture: 120 },
      classNeedWeights: { low: 50 },
    };
    const engine = configured(config);
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { dynamicNeeds: Record<string, number> }>;
    };
    expect(state.cohorts.rural!.dynamicNeeds.grain).toBe(2);
  });

  it('replays a settled migration deterministically from an engine snapshot', () => {
    const config: CityConfig = {
      ...cities,
      cohorts: [
        ...cities.cohorts,
        {
          ...cities.cohorts[0]!,
          id: 'urban',
          cityId: 'destination',
          population: 0,
          linkedEconomyCohortId: 'urban',
        },
      ],
      migrationBudget: 4,
    };
    const build = () => {
      const engine = createEngine({ initialState: {} }, 17);
      registerLocalEconomy(engine, {
        ...economy,
        owners: [...economy.owners, 'urban-households'],
        accounts: [
          ...economy.accounts,
          { id: 'urban-cash', ownerId: 'urban-households', openingBalance: 0 },
        ],
        cohorts: [
          ...economy.cohorts,
          {
            ...economy.cohorts[0]!,
            id: 'urban',
            cityId: 'destination',
            ownerId: 'urban-households',
            accountId: 'urban-cash',
          },
        ],
      });
      registerCities(engine, config);
      return engine;
    };
    const source = build();
    source.step();
    const restored = build();
    restored.restore(source.snapshot());
    expect(restored.run(2)).toEqual(source.run(2));
  });

  it('charges explicit service upkeep to the configured provider through accounting', () => {
    const config = {
      ...cities,
      cities: cities.cities.map((city) =>
        city.id === 'source'
          ? {
              ...city,
              serviceProvisionCost: 2,
              serviceAccountId: 'migration-fund',
              serviceProviderAccountId: 'carrier-cash',
            }
          : city,
      ),
    };
    const engine = configured(config);
    engine.run(1);
    const ledger = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
    };
    expect(ledger.accounts.find((a) => a.id === 'migration-fund')?.balance).toBe(18);
    expect(ledger.accounts.find((a) => a.id === 'carrier-cash')?.balance).toBe(102);
  });

  it('disables paid service capacity when upkeep runs out on a later tick', () => {
    const config: CityConfig = {
      ...cities,
      routes: [],
      cities: cities.cities.map((city) =>
        city.id === 'source'
          ? {
              ...city,
              serviceCapacity: { care: 4 },
              serviceProvisionCost: 2,
              serviceAccountId: 'migration-fund',
              serviceProviderAccountId: 'carrier-cash',
            }
          : city,
      ),
    };
    const engine = configured(config);
    engine.run(10);
    expect(
      (
        engine.getState().domain.cities as {
          cohorts: Record<string, { serviceCoverage: Record<string, number> }>;
        }
      ).cohorts.rural!.serviceCoverage.care,
    ).toBe(100);
    engine.step();
    const state = engine.getState().domain as {
      cities: {
        cohorts: Record<string, { serviceCoverage: Record<string, number> }>;
        serviceFundedThisTick: string[];
      };
      accounting: { accounts: Array<{ id: string; balance: number }> };
    };
    expect(state.cities.cohorts.rural!.serviceCoverage.care).toBe(0);
    expect(state.cities.serviceFundedThisTick).not.toContain('source');
    expect(state.accounting.accounts.find((a) => a.id === 'migration-fund')?.balance).toBe(0);
  });

  it('keeps migration at zero with no route or insufficient budget', () => {
    for (const override of [
      { ...cities, routes: [] },
      { ...cities, migrationBudget: 7 },
    ]) {
      const engine = configured(override);
      engine.run(1);
      const state = engine.getState().domain.cities as {
        cohorts: Record<string, { population: number; cityId: string }>;
        migration: unknown[];
      };
      expect(state.cohorts.rural).toMatchObject({ population: 4, cityId: 'source' });
      expect(state.migration).toEqual([]);
    }
  });
});
