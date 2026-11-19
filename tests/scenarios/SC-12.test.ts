import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerCities,
  registerLocalEconomy,
} from '../../packages/simulation-core/src/index.js';
import { createThreeNations as createThreeNationsFixture } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';

describe('SC-12 cohort migration', () => {
  it('moves only funded people toward real skill-matched jobs and employs them next tick', () => {
    const engine = createEngine({ initialState: {} }, 8);
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'cent', scale: 0 },
      commodities: [
        { id: 'seed', unit: 'kg', scale: 0 },
        { id: 'grain', unit: 'kg', scale: 0 },
      ],
      owners: ['people', 'seller', 'carrier', 'destination-people'],
      accounts: [
        { id: 'people-cash', ownerId: 'people', openingBalance: 100 },
        { id: 'destination-people-cash', ownerId: 'destination-people', openingBalance: 0 },
        { id: 'seller-cash', ownerId: 'seller', openingBalance: 100 },
        { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
        { id: 'fund-cash', ownerId: 'people', openingBalance: 10 },
      ],
      stock: [
        { ownerId: 'seller', commodity: 'grain', quantity: 50 },
        { ownerId: 'seller', commodity: 'seed', quantity: 10 },
      ],
      recipes: [
        {
          id: 'harvest',
          inputs: [{ commodity: 'seed', quantity: 1 }],
          outputs: [{ commodity: 'grain', quantity: 1 }],
        },
      ],
      producers: [
        {
          id: 'destination-farm',
          cityId: 'destination',
          ownerId: 'seller',
          accountId: 'seller-cash',
          recipeId: 'harvest',
          laborPerBatch: 1,
          maxBatches: 2,
          wagePerBatch: 1,
          requiredSkills: { farming: 1 },
        },
      ],
      cohorts: [
        {
          id: 'group',
          cityId: 'origin',
          ownerId: 'people',
          accountId: 'people-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
        {
          id: 'destination-group',
          cityId: 'destination',
          ownerId: 'destination-people',
          accountId: 'destination-people-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
      ],
      sellers: ['origin', 'destination'].map((cityId) => ({
        cityId,
        commodity: 'grain',
        ownerId: 'seller',
        accountId: 'seller-cash',
        minPrice: 1,
        maxPrice: 3,
        openingPrice: 1,
      })),
    });
    registerCities(engine, {
      cities: [
        { id: 'origin', serviceCapacity: { care: 0 }, serviceProvisionCost: 0 },
        { id: 'destination', serviceCapacity: { care: 0 }, serviceProvisionCost: 0 },
      ],
      cohorts: [
        {
          id: 'group',
          cityId: 'origin',
          population: 2,
          category: 'rural',
          class: 'low',
          skills: { farming: 1 },
          needs: { grain: 1 },
          incomePerPerson: 0,
          serviceNeeds: { care: 1 },
          welfare: 50,
          linkedEconomyCohortId: 'group',
        },
        {
          id: 'destination-group',
          cityId: 'destination',
          population: 0,
          category: 'rural',
          class: 'low',
          skills: { farming: 1 },
          needs: { grain: 1 },
          incomePerPerson: 0,
          serviceNeeds: { care: 1 },
          welfare: 50,
          linkedEconomyCohortId: 'destination-group',
        },
      ],
      routes: [{ fromCityId: 'origin', toCityId: 'destination', costPerPerson: 2 }],
      carrierAccountId: 'carrier-cash',
      migrationFundingAccountId: 'fund-cash',
      migrationBudget: 3,
    });
    engine.run(2);
    const state = engine.getState().domain as {
      cities: {
        cohorts: Record<
          string,
          { cityId: string; population: number; employment: number; incomeThisTick: number }
        >;
        migration: Array<{
          fromCohortId: string;
          toCohortId: string;
          population: number;
          cost: number;
        }>;
      };
      economy: { cohorts: Record<string, { unmet: Record<string, number> }> };
      accounting: { accounts: Array<{ id: string; balance: number }> };
    };
    expect(state.cities.migration).toEqual([
      {
        fromCohortId: 'group',
        toCohortId: 'destination-group',
        fromCityId: 'origin',
        toCityId: 'destination',
        population: 1,
        cost: 2,
        tick: 1,
      },
    ]);
    expect(state.cities.cohorts.group).toMatchObject({ cityId: 'origin', population: 1 });
    expect(state.cities.cohorts['destination-group']).toMatchObject({
      cityId: 'destination',
      population: 1,
      employment: 1,
      incomeThisTick: 1,
    });
    expect(state.economy.cohorts['destination-group']!.unmet.grain).toBe(0);
    expect(state.accounting.accounts.find((x) => x.id === 'fund-cash')?.balance).toBe(8);
  });

  it('does not migrate toward a vacant job when the cohort lacks its required skill', () => {
    const engine = createEngine({ initialState: {} }, 8);
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'cent', scale: 0 },
      commodities: [{ id: 'grain', unit: 'kg', scale: 0 }],
      owners: ['people', 'seller', 'carrier', 'destination-people'],
      accounts: ['people', 'seller', 'carrier', 'destination-people'].map((ownerId) => ({
        id: `${ownerId}-cash`,
        ownerId,
        openingBalance: ownerId === 'people' ? 10 : 0,
      })),
      cohorts: ['origin-group', 'destination-group'].map((id, i) => ({
        id,
        cityId: i ? 'destination' : 'origin',
        ownerId: i ? 'destination-people' : 'people',
        accountId: i ? 'destination-people-cash' : 'people-cash',
        workersAvailable: 0,
        desiredNeeds: { grain: 1 },
      })),
      recipes: [
        {
          id: 'skill-job',
          inputs: [{ commodity: 'grain', quantity: 1 }],
          outputs: [{ commodity: 'grain', quantity: 1 }],
        },
      ],
      producers: [
        {
          id: 'skilled-job',
          cityId: 'destination',
          ownerId: 'seller',
          accountId: 'seller-cash',
          recipeId: 'skill-job',
          laborPerBatch: 1,
          maxBatches: 1,
          wagePerBatch: 0,
          requiredSkills: { farming: 1 },
        },
      ],
      sellers: [],
    });
    registerCities(engine, {
      cities: [
        { id: 'origin', serviceCapacity: {}, serviceProvisionCost: 0 },
        { id: 'destination', serviceCapacity: {}, serviceProvisionCost: 0 },
      ],
      cohorts: ['origin-group', 'destination-group'].map((id, i) => ({
        id,
        cityId: i ? 'destination' : 'origin',
        population: i ? 0 : 1,
        category: 'rural',
        class: 'low',
        skills: {},
        needs: { grain: 1 },
        incomePerPerson: 0,
        serviceNeeds: {},
        welfare: 50,
        linkedEconomyCohortId: id,
      })),
      routes: [{ fromCityId: 'origin', toCityId: 'destination', costPerPerson: 1 }],
      carrierAccountId: 'carrier-cash',
      migrationFundingAccountId: 'people-cash',
      migrationBudget: 1,
    });
    engine.run(1);
    const state = engine.getState().domain.cities as {
      cohorts: Record<string, { population: number }>;
      migration: unknown[];
    };
    expect(state.cohorts['origin-group']!.population).toBe(1);
    expect(state.cohorts['destination-group']!.population).toBe(0);
    expect(state.migration).toEqual([]);
  });
});

// T16 extension — three-nations fixture: a skill-matched vacancy with a funded migration budget
// moves population between two identical mountain cohorts; the unfunded control moves nobody.
describe('SC-12 three-nations funded migration', () => {
  const drive = (migrationBudget: number) => {
    const fixture = createThreeNationsFixture({
      ticks: 8,
      variant: migrationBudget > 0 ? { migrationBudget } : {},
    });
    const commands = [];
    for (let tick = 1; tick <= 8; tick++) commands.push(...fixture.commandsForTick(tick));
    for (const command of commands) fixture.engine.submit(command);
    fixture.engine.run(8);
    return fixture.engine.getState().domain;
  };

  it('moves exactly the funded count from source to destination cohort', () => {
    const domain = drive(500);
    const cities = domain.cities as {
      cohorts: Record<string, { population: number }>;
      migration: Array<{ fromCohortId: string; toCohortId: string; population: number }>;
    };
    expect(cities.migration.length).toBeGreaterThan(0);
    const moved = cities.migration.reduce((sum, m) => sum + m.population, 0);
    expect(moved).toBeGreaterThan(0);
    const sourceBefore = 100;
    const destinationBefore = 6;
    expect(cities.cohorts['mount-hold-residents']!.population).toBe(sourceBefore - moved);
    expect(cities.cohorts['mount-forge-residents']!.population).toBe(destinationBefore + moved);

    const control = drive(0);
    const controlCities = control.cities as {
      cohorts: Record<string, { population: number }>;
      migration: unknown[];
    };
    expect(controlCities.migration).toHaveLength(0);
    expect(controlCities.cohorts['mount-hold-residents']!.population).toBe(100);
  }, 900000);
});
