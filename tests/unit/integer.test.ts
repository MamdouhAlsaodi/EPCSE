import { describe, expect, it } from 'vitest';
import {
  checkedAdd,
  checkedMultiply,
  divideFloorWithRemainder,
} from '../../packages/simulation-core/src/shared/integer.js';

describe('checked integer arithmetic', () => {
  it('uses wide intermediates and rejects unsafe results', () => {
    expect(checkedAdd(4, 5)).toBe(9);
    expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe|overflow/i);
    expect(() => checkedMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(/safe|overflow/i);
  });

  it('floors division and returns the remainder to the payer', () => {
    expect(divideFloorWithRemainder(10, 3)).toEqual({ quotient: 3, remainder: 1 });
  });

  it('rejects malformed, fractional and nonpositive divisors', () => {
    expect(() => checkedAdd(1.5, 2)).toThrow();
    expect(() => divideFloorWithRemainder(1, 0)).toThrow();
  });
});
