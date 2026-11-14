import { COMMODITIES, type Commodity } from './commodity.js';

export interface PopulationNeed {
  readonly commodity: Commodity;
  readonly quantity: number;
}

export interface PopulationCohortInput {
  readonly cohortId: string;
  readonly cityId: string;
  readonly population: number;
  readonly needs: readonly PopulationNeed[];
  readonly openingBudget: number;
}

export interface PopulationLedgerInput {
  readonly cohorts: readonly PopulationCohortInput[];
}

export interface PopulationSnapshot {
  readonly cohorts: readonly PopulationCohortInput[];
}

export interface PopulationLedger {
  getState(): PopulationSnapshot;
}

export function createPopulationLedger(input: PopulationLedgerInput): PopulationLedger {
  const cohortIds = new Set<string>();
  const validateId = (id: string, label: string): void => {
    if (typeof id !== 'string') throw new TypeError(`${label} must be a string`);
    if (id.length === 0) throw new RangeError(`${label} must be nonempty`);
  };
  const validatePositiveInteger = (value: number, label: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError(`${label} must be a finite integer`);
    }
    if (value <= 0 || !Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a positive safe integer`);
    }
  };
  const validateBudget = (value: number): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError('opening budget must be a finite integer');
    }
    if (value < 0 || !Number.isSafeInteger(value)) {
      throw new RangeError('opening budget must be a nonnegative safe integer');
    }
  };

  for (const cohort of input.cohorts) {
    validateId(cohort.cohortId, 'cohort id');
    validateId(cohort.cityId, 'city id');
    if (cohortIds.has(cohort.cohortId)) {
      throw new RangeError(`duplicate cohort id: ${cohort.cohortId}`);
    }
    validatePositiveInteger(cohort.population, 'population');
    validateBudget(cohort.openingBudget);
    if (!Array.isArray(cohort.needs)) throw new TypeError('cohort needs must be an array');
    const commodities = new Set<Commodity>();
    for (const need of cohort.needs) {
      if (!(COMMODITIES as readonly string[]).includes(need.commodity)) {
        throw new RangeError(`unknown commodity: ${need.commodity}`);
      }
      validatePositiveInteger(need.quantity, 'need quantity');
      if (commodities.has(need.commodity)) {
        throw new RangeError(`duplicate need commodity: ${need.commodity}`);
      }
      commodities.add(need.commodity);
    }
    cohortIds.add(cohort.cohortId);
  }

  const cohorts = input.cohorts.map((cohort) => ({
    ...cohort,
    needs: cohort.needs.map((need) => ({ ...need })),
  }));
  return {
    getState: () => ({
      cohorts: cohorts.map((cohort) => ({
        ...cohort,
        needs: cohort.needs.map((need) => ({ ...need })),
      })),
    }),
  };
}
