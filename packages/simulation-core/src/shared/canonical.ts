import { createHash } from 'node:crypto';

export function cloneJson<T>(value: T): T {
  const active = new WeakSet<object>();
  const clone = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item))
        throw new TypeError('only safe integer numbers are supported');
      return item;
    }
    if (
      typeof item !== 'object' ||
      Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)
    )
      throw new TypeError('plain JSON values required');
    if (active.has(item)) throw new TypeError('cyclic JSON value');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const result: unknown[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor))
            throw new TypeError('array accessors and holes are not JSON values');
          result.push(clone(descriptor.value));
        }
        if (Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key)))
          throw new TypeError('arrays cannot have extra properties');
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('object accessors are not JSON values');
        Object.defineProperty(result, key, {
          value: clone(descriptor.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      active.delete(item);
    }
  };
  return clone(value) as T;
}
export function canonical(value: unknown): string {
  const normalized = cloneJson(value);
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    const object = item as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
      .join(',')}}`;
  };
  return encode(normalized);
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
