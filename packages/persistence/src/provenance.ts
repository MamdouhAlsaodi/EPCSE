import { createHash, randomUUID, createHmac } from 'node:crypto';
import { SnapshotProvenanceError } from './errors.js';

export interface VersionTuple {
  schema: number;
  engine: number;
  rules: number;
  canonical: number;
  phase: number;
}

/**
 * Persisted provenance record. Structurally identical to the protected port's
 * `PersistedProvenance` in packages/simulation-core/src/ports/persistence.ts;
 * the port cannot be imported across packages (its exports map has no subpath
 * and the allowlist forbids editing simulation-core's package.json), so this
 * type mirrors it and tests assert assignability.
 */
export interface PersistedProvenance {
  snapshotId: string;
  worldId: string;
  runId: string | null;
  tick: number;
  versions: VersionTuple;
  createdAt: string;
  writerId: string;
  payloadSha256: string;
  nonce: string;
  hmac: string;
}

export interface ProvenanceInput {
  snapshotId: string;
  worldId: string;
  runId: string | null;
  tick: number;
  createdAt: string;
  payloadSha256: string;
  nonce: string;
}

export function computePayloadSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function generateNonce(): string {
  return randomUUID();
}

/**
 * HMAC-SHA-256 over the canonical string
 * `payloadSha256 || snapshotId || worldId || runId || tick || createdAt || nonce`.
 * The random nonce (generated inside this package, stored with the record) is
 * part of the MAC input, so two saves of identical bytes in the same second
 * produce different MACs — an identical-MAC double-append into a single-use
 * journal is a replay hazard.
 */
export function computeProvenanceHmac(key: string, record: ProvenanceInput): string {
  const input = [
    record.payloadSha256,
    record.snapshotId,
    record.worldId,
    record.runId ?? '',
    String(record.tick),
    record.createdAt,
    record.nonce,
  ].join('||');
  return createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

/** Required at write time; env-injected, never persisted to DB or disk in-repo. */
export function requireHmacKey(): string {
  const key = process.env.EPCSE_SNAPSHOT_HMAC_KEY;
  if (!key || key.length === 0)
    throw new SnapshotProvenanceError(
      'EPCSE_SNAPSHOT_HMAC_KEY is not set; refusing to write provenance',
    );
  return key;
}
