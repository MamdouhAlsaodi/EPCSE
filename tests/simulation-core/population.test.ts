import { describe, expect, it } from 'vitest';
import { createPopulationLedger } from '@epcse/simulation-core';

describe('population ledger', () => {
  it('preserves declared cohort records in insertion order with defensive snapshots', () => {
    const input = {
      cohorts: [
        {
          cohortId: 'workers-north',
          cityId: 'north',
          population: 12,
          needs: [{ commodity: 'grain' as const, quantity: 2 }],
          openingBudget: 40,
        },
        {
          cohortId: 'families-south',
          cityId: 'south',
          population: 5,
          needs: [{ commodity: 'wood' as const, quantity: 1 }],
          openingBudget: 0,
        },
      ],
    };
    const ledger = createPopulationLedger(input);
    const snapshot = ledger.getState() as unknown as {
      cohorts: { cohortId: string; needs: { quantity: number }[] }[];
    };
    snapshot.cohorts[0]!.cohortId = 'changed';
    snapshot.cohorts[0]!.needs[0]!.quantity = 99;
    snapshot.cohorts.reverse();

    expect(ledger.getState()).toEqual(input);
  });

  it('rejects invalid cohort declarations without exposing partial records', () => {
    const valid = {
      cohortId: 'workers',
      cityId: 'north',
      population: 2,
      needs: [{ commodity: 'grain' as const, quantity: 1 }],
      openingBudget: 0,
    };
    const invalidCohorts = [
      { ...valid, cohortId: '' },
      { ...valid, cityId: '' },
      { ...valid, population: 0 },
      { ...valid, population: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, openingBudget: -1 },
      { ...valid, openingBudget: 1.5 },
      { ...valid, needs: [{ commodity: 'grain' as const, quantity: 0 }] },
      { ...valid, needs: [{ commodity: 'unknown' as 'grain', quantity: 1 }] },
      {
        ...valid,
        needs: [
          { commodity: 'grain' as const, quantity: 1 },
          { commodity: 'grain' as const, quantity: 2 },
        ],
      },
    ];

    for (const cohort of invalidCohorts) {
      expect(() => createPopulationLedger({ cohorts: [valid, cohort] })).toThrow();
    }
    expect(() => createPopulationLedger({ cohorts: [valid, valid] })).toThrow(/duplicate cohort/);
  });
});
