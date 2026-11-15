import { describe, expect, it } from 'vitest';
import { canonical, decodeJson } from '../../packages/simulation-core/src/index.js';

describe('snapshot codec', () => {
  it('canonicalizes numeric-looking object keys by UTF-16 lexical order', () => {
    expect(canonical({ 2: 'two', 10: 'ten' })).toBe('{"10":"ten","2":"two"}');
  });

  it('preserves an own __proto__ key without mutating prototypes', () => {
    const decoded = decodeJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects duplicate keys and unsafe values', () => {
    expect(() => decodeJson('{"x":1,"x":2}')).toThrow(/duplicate JSON key/);
    expect(() => decodeJson('{"x":9007199254740992}')).toThrow();
    expect(() => decodeJson('\v{}')).toThrow();
  });
});
