/** Inputs for the intentionally simplistic provisional supply/demand price. */
export interface ProvisionalPriceInput {
  /** Positive integer money units. */
  basePrice: number;
  /** Nonnegative integer units demanded in the evaluated period. */
  demand: number;
  /** Nonnegative integer units supplied in the evaluated period. */
  supply: number;
  /** Positive integer money units. */
  maxPrice: number;
}

/**
 * Calculates floor(basePrice * (demand + 1) / (supply + 1)), then clamps it
 * to [1, maxPrice]. This demonstration uses no market state or time window.
 */
export function calculateProvisionalPrice({
  basePrice,
  demand,
  supply,
  maxPrice,
}: ProvisionalPriceInput): number {
  if (!Number.isSafeInteger(demand) || demand < 0) {
    throw new RangeError('demand must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(supply) || supply < 0) {
    throw new RangeError('supply must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0) {
    throw new RangeError('basePrice must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPrice) || maxPrice <= 0) {
    throw new RangeError('maxPrice must be a positive safe integer');
  }

  const calculated = (BigInt(basePrice) * (BigInt(demand) + 1n)) / (BigInt(supply) + 1n);
  return Number(
    calculated < 1n ? 1n : calculated > BigInt(maxPrice) ? BigInt(maxPrice) : calculated,
  );
}
