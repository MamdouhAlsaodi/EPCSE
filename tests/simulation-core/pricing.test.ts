import { describe, expect, it } from 'vitest';
import { calculateProvisionalPrice } from '../../packages/simulation-core/src/index.js';

describe('provisional supply/demand pricing', () => {
  it('floors the capped base-price ratio and uses safe intermediates', () => {
    expect(calculateProvisionalPrice({ basePrice: 10, demand: 2, supply: 3, maxPrice: 20 })).toBe(
      7,
    );
    expect(
      calculateProvisionalPrice({
        basePrice: Number.MAX_SAFE_INTEGER,
        demand: Number.MAX_SAFE_INTEGER,
        supply: Number.MAX_SAFE_INTEGER,
        maxPrice: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('clamps to both price bounds and is monotonic for fixed other inputs', () => {
    expect(calculateProvisionalPrice({ basePrice: 1, demand: 0, supply: 10, maxPrice: 20 })).toBe(
      1,
    );
    expect(calculateProvisionalPrice({ basePrice: 10, demand: 100, supply: 0, maxPrice: 7 })).toBe(
      7,
    );
    expect(
      calculateProvisionalPrice({ basePrice: 10, demand: 3, supply: 4, maxPrice: 20 }),
    ).toBeLessThanOrEqual(
      calculateProvisionalPrice({ basePrice: 10, demand: 4, supply: 4, maxPrice: 20 }),
    );
    expect(
      calculateProvisionalPrice({ basePrice: 10, demand: 4, supply: 3, maxPrice: 20 }),
    ).toBeGreaterThanOrEqual(
      calculateProvisionalPrice({ basePrice: 10, demand: 4, supply: 4, maxPrice: 20 }),
    );
  });

  it('rejects values outside the specified integer domains', () => {
    for (const demand of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        calculateProvisionalPrice({ basePrice: 1, demand, supply: 0, maxPrice: 1 }),
      ).toThrow();
    }
    for (const supply of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        calculateProvisionalPrice({ basePrice: 1, demand: 0, supply, maxPrice: 1 }),
      ).toThrow();
    }
    for (const basePrice of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        calculateProvisionalPrice({ basePrice, demand: 0, supply: 0, maxPrice: 1 }),
      ).toThrow();
    }
    for (const maxPrice of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        calculateProvisionalPrice({ basePrice: 1, demand: 0, supply: 0, maxPrice }),
      ).toThrow();
    }
  });
});
