import { describe, expect, it } from 'vitest';
import { canonical } from '@epcse/simulation-core';
import {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  RunConflictError,
  SnapshotCorruptError,
  SnapshotIncompatibleError,
  SnapshotError,
  SnapshotProvenanceError,
  SnapshotSizeError,
  computePayloadSha256,
  computeProvenanceHmac,
  generateNonce,
  validateSnapshotText,
} from '../../packages/persistence/src/index.js';

process.env.EPCSE_SNAPSHOT_HMAC_KEY ??= 't17-unit-test-key';

function snapshotText(tick = 0, versions: Record<string, number> = {}): string {
  return canonical({
    schemaVersion: 1,
    engineVersion: 1,
    rulesVersion: 1,
    canonicalVersion: 1,
    phaseVersion: 1,
    tick,
    domain: { value: 0 },
    ...versions,
  });
}

describe('snapshot validation', () => {
  it('extracts the version tuple from snapshot text', () => {
    expect(validateSnapshotText(snapshotText(42), { maxBytes: 1024 })).toEqual({
      schema: 1,
      engine: 1,
      rules: 1,
      canonical: 1,
      phase: 1,
    });
  });

  it('rejects corrupt text with SnapshotCorruptError, including duplicate JSON keys', () => {
    expect(() => validateSnapshotText('not json', { maxBytes: 1024 })).toThrow(
      SnapshotCorruptError,
    );
    expect(() => validateSnapshotText('{"tick":1,"tick":2}', { maxBytes: 1024 })).toThrow(
      SnapshotCorruptError,
    );
  });

  it('rejects a missing or mismatched version tuple with SnapshotIncompatibleError', () => {
    const missing = canonical({ tick: 0, domain: {} });
    expect(() => validateSnapshotText(missing, { maxBytes: 1024 })).toThrow(
      SnapshotIncompatibleError,
    );
    expect(() =>
      validateSnapshotText(snapshotText(0, { engineVersion: 2 }), { maxBytes: 1024 }),
    ).toThrow(SnapshotIncompatibleError);
  });

  it('enforces the size cap before structural checks', () => {
    const big = snapshotText(0) + ' '.repeat(64);
    expect(() => validateSnapshotText(big, { maxBytes: 32 })).toThrow(SnapshotSizeError);
    expect(DEFAULT_MAX_SNAPSHOT_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('provenance HMAC', () => {
  const record = {
    snapshotId: '11111111-1111-4111-8111-111111111111',
    worldId: 'w1',
    runId: null,
    tick: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    payloadSha256: computePayloadSha256('payload'),
    nonce: 'nonce-1',
  };

  it('is deterministic for identical inputs', () => {
    const a = computeProvenanceHmac('key', record);
    const b = computeProvenanceHmac('key', record);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the key, payload digest, or nonce', () => {
    const base = computeProvenanceHmac('key', record);
    expect(computeProvenanceHmac('other-key', record)).not.toBe(base);
    expect(
      computeProvenanceHmac('key', { ...record, payloadSha256: computePayloadSha256('other') }),
    ).not.toBe(base);
    expect(computeProvenanceHmac('key', { ...record, nonce: 'nonce-2' })).not.toBe(base);
  });

  it('generates unique nonces so identical bytes in the same second produce different MACs', () => {
    const nonceA = generateNonce();
    const nonceB = generateNonce();
    expect(nonceA).not.toBe(nonceB);
    const shared = { ...record, createdAt: '2026-01-01T00:00:00.000Z' };
    const macA = computeProvenanceHmac('key', { ...shared, nonce: nonceA });
    const macB = computeProvenanceHmac('key', { ...shared, nonce: nonceB });
    expect(macA).not.toBe(macB);
  });
});

describe('error taxonomy', () => {
  it('keeps each error class distinct on a shared SnapshotError base', () => {
    const classes = [
      SnapshotProvenanceError,
      SnapshotIncompatibleError,
      SnapshotCorruptError,
      SnapshotSizeError,
      RunConflictError,
    ];
    for (const cls of classes) {
      const err: SnapshotError = new (cls as new (message: string) => SnapshotError)('x');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SnapshotError);
      for (const other of classes) {
        expect(err instanceof other).toBe(other === cls);
      }
      expect(() => {
        throw err;
      }).toThrow(cls);
    }
  });
});
