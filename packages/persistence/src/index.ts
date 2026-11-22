/**
 * @epcse/persistence — durable, provenance-authenticated snapshots + run log.
 *
 * TRUST RULE: snapshot content is trusted-only. It enters storage exclusively
 * via `SnapshotRepository.saveSnapshot` from a trusted engine instance
 * (`engine.snapshotText()`); there is NO import-from-caller route. Provenance
 * (writerId/createdAt/nonce/payloadSha256/HMAC) authenticates the WRITER;
 * structural validation (versions/size/canonical JSON) is integrity-only and
 * never constitutes payment or identity evidence. `loadSnapshot` returns
 * opaque bytes plus writer metadata; the API layer (T18) must derive payment
 * evidence only from run command rows and receipts.
 */
export {
  SnapshotError,
  SnapshotProvenanceError,
  SnapshotIncompatibleError,
  SnapshotCorruptError,
  SnapshotSizeError,
  RunConflictError,
} from './errors.js';
export {
  computePayloadSha256,
  computeProvenanceHmac,
  generateNonce,
  requireHmacKey,
  type ProvenanceInput,
  type PersistedProvenance,
  type VersionTuple,
} from './provenance.js';
export {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  maxSnapshotBytesFromEnv,
  validateSnapshotText,
  extractVersions,
} from './validation.js';
export { runMigrations, MIGRATIONS } from './migrations/index.js';
export {
  SnapshotRepository,
  createSnapshotRepository,
} from './repositories/snapshot-repository.js';
export { RunRepository, createRunRepository } from './repositories/run-repository.js';
export type { RunRecord, CommandRecord } from './repositories/run-repository.js';
export * from './schema.js';
