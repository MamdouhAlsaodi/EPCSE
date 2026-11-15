export class Mulberry32 {
  constructor(public state: number) {
    if (!Number.isSafeInteger(state) || state < 0 || state > 0xffffffff)
      throw new RangeError('seed must be uint32');
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  }
}
