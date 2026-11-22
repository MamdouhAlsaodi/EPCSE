import { decodeJson } from '@epcse/simulation-core';
import { SnapshotCorruptError, SnapshotIncompatibleError, SnapshotSizeError } from './errors.js';
import type { VersionTuple } from './provenance.js';

export const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export function maxSnapshotBytesFromEnv(): number {
  const raw = process.env.EPCSE_SNAPSHOT_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_SNAPSHOT_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new RangeError('EPCSE_SNAPSHOT_MAX_BYTES must be a positive safe integer');
  return parsed;
}

/**
 * Integrity-only validation pipeline (never payment/identity evidence):
 * 1. byte-size cap, BEFORE any structural work,
 * 2. strict canonical-JSON decode (duplicate keys / trailing input rejected),
 * 3. version tuple extraction against the supported set — explicit, no silent
 *    migration.
 */
export function validateSnapshotText(text: string, opts: { maxBytes?: number } = {}): VersionTuple {
  const maxBytes = opts.maxBytes ?? maxSnapshotBytesFromEnv();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new SnapshotSizeError(maxBytes);
  let parsed: unknown;
  try {
    parsed = decodeJson(text);
  } catch {
    throw new SnapshotCorruptError();
  }
  const versions = extractVersions(parsed);
  const expected = { schema: 1, engine: 1, rules: 1, canonical: 1, phase: 1 };
  for (const key of Object.keys(expected) as (keyof VersionTuple)[])
    if (versions[key] !== expected[key])
      throw new SnapshotIncompatibleError(
        `snapshot ${key}Version is missing or unsupported (got ${String(versions[key])})`,
      );
  return versions;
}

export function extractVersions(parsed: unknown): VersionTuple {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new SnapshotCorruptError('snapshot text is not a JSON object');
  const record = parsed as Record<string, unknown>;
  const read = (suffix: string): number => {
    const value = record[`${suffix}Version`];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN;
  };
  return {
    schema: read('schema'),
    engine: read('engine'),
    rules: read('rules'),
    canonical: read('canonical'),
    phase: read('phase'),
  };
}
