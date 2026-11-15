const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MIN = BigInt(Number.MIN_SAFE_INTEGER);

function integer(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
  return BigInt(value);
}

function safe(value: bigint, name: string): number {
  if (value > MAX || value < MIN)
    throw new RangeError(`${name} overflow: result is not a safe integer`);
  return Number(value);
}

export function checkedAdd(left: number, right: number): number {
  return safe(integer(left, 'left operand') + integer(right, 'right operand'), 'addition');
}

export function checkedSubtract(left: number, right: number): number {
  return safe(integer(left, 'left operand') - integer(right, 'right operand'), 'subtraction');
}

export function checkedMultiply(left: number, right: number): number {
  return safe(integer(left, 'left operand') * integer(right, 'right operand'), 'multiplication');
}

export function divideFloorWithRemainder(
  dividend: number,
  divisor: number,
): { quotient: number; remainder: number } {
  const a = integer(dividend, 'dividend');
  const b = integer(divisor, 'divisor');
  if (b <= 0n) throw new RangeError('divisor must be positive');
  if (a < 0n) throw new RangeError('dividend must be nonnegative');
  return { quotient: safe(a / b, 'division'), remainder: safe(a % b, 'remainder') };
}
