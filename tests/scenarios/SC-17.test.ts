import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerCities,
  registerLocalEconomy,
  type CityConfig,
} from '../../packages/simulation-core/src/index.js';

const economy = {
  currency: { id: 'coin', unit: 'cent', scale: 0 },
  commodities: [{ id: 'grain', unit: 'kg', scale: 0 }],
  owners: ['people', 'seller', 'carrier'],
  accounts: [
    { id: 'people-cash', ownerId: 'people', openingBalance: 0 },
    { id: 'seller-cash', ownerId: 'seller', openingBalance: 0 },
    { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
    { id: 'fund-cash', ownerId: 'people', openingBalance: 0 },
  ],
  cohorts: [
    {
      id: 'empty',
      cityId: 'isolated',
      ownerId: 'people',
      accountId: 'people-cash',
      workersAvailable: 0,
      desiredNeeds: { grain: 0 },
    },
  ],
  producers: [],
  sellers: [],
};
const cityConfig: CityConfig = {
  cities: [{ id: 'isolated', serviceCapacity: { care: 0 }, serviceProvisionCost: 0 }],
  cohorts: [
    {
      id: 'empty',
      cityId: 'isolated',
      population: 0,
      category: 'rural',
      class: 'low',
      skills: {},
      needs: { grain: 1 },
      incomePerPerson: 0,
      serviceNeeds: { care: 1 },
      welfare: 50,
      linkedEconomyCohortId: 'empty',
    },
  ],
  routes: [],
  carrierAccountId: 'carrier-cash',
  migrationFundingAccountId: 'fund-cash',
  migrationBudget: 0,
};

describe('SC-17 city boundaries', () => {
  it('keeps isolated zero-population cohorts finite with no migration', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, economy);
    registerCities(engine, cityConfig);
    engine.run(2);
    const state = engine.getState().domain.cities as {
      cohorts: Record<
        string,
        {
          population: number;
          welfare: number;
          dynamicNeeds: Record<string, number>;
          serviceCoverage: Record<string, number>;
        }
      >;
      migration: unknown[];
    };
    expect(state.cohorts.empty).toMatchObject({
      population: 0,
      welfare: 50,
      dynamicNeeds: { grain: 0 },
      serviceCoverage: { care: 100 },
    });
    expect(state.migration).toEqual([]);
    expect(JSON.stringify(state)).not.toMatch(/NaN|Infinity/);
  });

  it('does not migrate when the payer has no available funds', () => {
    const engine = createEngine({ initialState: {} }, 1);
    const fundedRoute = {
      ...economy,
      owners: [...economy.owners, 'destination-people'],
      accounts: [
        ...economy.accounts,
        { id: 'destination-cash', ownerId: 'destination-people', openingBalance: 0 },
      ],
      cohorts: [
        ...economy.cohorts,
        {
          id: 'destination',
          cityId: 'destination',
          ownerId: 'destination-people',
          accountId: 'destination-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 0 },
        },
      ],
    };
    registerLocalEconomy(engine, fundedRoute);
    registerCities(engine, {
      ...cityConfig,
      cities: [
        ...cityConfig.cities,
        { id: 'destination', serviceCapacity: { care: 100 }, serviceProvisionCost: 0 },
      ],
      cohorts: [
        { ...cityConfig.cohorts[0]!, population: 1 },
        {
          ...cityConfig.cohorts[0]!,
          id: 'destination',
          cityId: 'destination',
          population: 0,
          linkedEconomyCohortId: 'destination',
        },
      ],
      routes: [{ fromCityId: 'isolated', toCityId: 'destination', costPerPerson: 1 }],
    });
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { population: number }>;
      migration: unknown[];
    };
    expect(state.cohorts.empty!.population).toBe(1);
    expect(state.cohorts.destination!.population).toBe(0);
    expect(state.migration).toEqual([]);
  });

  it('rolls back an overflowing need calculation without publishing partial city state', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, economy);
    registerCities(engine, {
      ...cityConfig,
      cohorts: [
        { ...cityConfig.cohorts[0]!, population: 2, needs: { grain: Number.MAX_SAFE_INTEGER } },
      ],
    });
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow(/overflow/i);
    expect(engine.snapshotText()).toBe(before);
  });

  it('rejects unsafe population and route costs before registration', () => {
    const bad = {
      ...cityConfig,
      cohorts: [{ ...cityConfig.cohorts[0]!, population: Number.MAX_SAFE_INTEGER + 1 }],
    };
    expect(() => registerCities(createEngine({ initialState: {} }, 1), bad)).toThrow(/population/i);
    expect(() =>
      registerCities(createEngine({ initialState: {} }, 1), {
        ...cityConfig,
        routes: [
          { fromCityId: 'isolated', toCityId: 'isolated', costPerPerson: Number.MAX_SAFE_INTEGER },
        ],
      }),
    ).toThrow(/route/i);
  });
});
