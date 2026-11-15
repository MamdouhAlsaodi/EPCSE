import { cloneJson } from '../shared/canonical.js';

// JSON.parse cannot report duplicate member names; scan each object before accepting its value.
export function decodeJson(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('snapshot text required');
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /[\x20\t\r\n]/.test(text[i]!)) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new SyntaxError('invalid JSON string');
  };
  const value = (): unknown => {
    ws();
    if (text[i] === '{') {
      i++;
      ws();
      const obj: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      while (true) {
        ws();
        if (text[i] !== '"') throw new SyntaxError('expected object key');
        const key = string();
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`);
        keys.add(key);
        ws();
        if (text[i++] !== ':') throw new SyntaxError('expected colon');
        Object.defineProperty(obj, key, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        if (text[i++] !== ',') throw new SyntaxError('expected comma');
      }
    }
    if (text[i] === '[') {
      i++;
      ws();
      const arr: unknown[] = [];
      if (text[i] === ']') {
        i++;
        return arr;
      }
      while (true) {
        arr.push(value());
        ws();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        if (text[i++] !== ',') throw new SyntaxError('expected comma');
      }
    }
    if (text[i] === '"') return string();
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    if (start === i) throw new SyntaxError('invalid JSON');
    return JSON.parse(text.slice(start, i)) as unknown;
  };
  const result = value();
  ws();
  if (i !== text.length) throw new SyntaxError('trailing JSON input');
  return cloneJson(result);
}
