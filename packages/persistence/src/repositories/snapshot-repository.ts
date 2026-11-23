import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { SnapshotProvenanceError, SnapshotSizeError } from '../errors.js';
import {
  computePayloadSha256,
  computeProvenanceHmac,
  generateNonce,
  requireHmacKey,
  type PersistedProvenance,
  type VersionTuple,
} from '../provenance.js';
import { maxSnapshotBytesFromEnv, validateSnapshotText } from '../validation.js';
import { snapshotProvenance, snapshots, runs } from '../schema.js';

export class SnapshotRepository {
  private readonly db: ReturnType<typeof drizzle>;
  private hmacKey: string | undefined;
  private maxBytes: number | undefined;

  constructor(pool: Pool) {
    this.db = drizzle(pool);
  }

  /** Runtime key injection (ops/tests). Undefined = read from env at call time. */
  setHmacKey(key: string | undefined): void {
    this.hmacKey = key;
  }

  /** Runtime size-budget override. Undefined = env/default at call time. */
  setMaxBytes(maxBytes: number | undefined): void {
    this.maxBytes = maxBytes;
  }

  private key(): string {
    return this.hmacKey ?? requireHmacKey();
  }

  private limit(): number {
    return this.maxBytes ?? maxSnapshotBytesFromEnv();
  }

  /**
   * Trusted-writer path: the ONLY way caller-side content may enter storage.
   * Atomic single transaction: snapshot row + provenance row commit together;
   * a failed write publishes nothing partial. When meta.runId is supplied it
   * is verified INSIDE the transaction to reference a run of THIS world —
   * a forged cross-world pairing (runId from another world) mutates nothing.
   * Legacy usage without a runId remains legitimate (runId stored as NULL).
   */
  async saveSnapshot(
    worldId: string,
    snapshotText: string,
    meta: { runId?: string | null; tick: number; writerId: string },
  ): Promise<PersistedProvenance> {
    const versions = this.sealChecks(worldId, snapshotText, meta);
    return this.persist(worldId, snapshotText, meta, versions);
  }

  /**
   * Test/ops seam: a trusted writer records content WITHOUT structural
   * validation (valid HMAC, unvalidated bytes). Used to prove that storage +
   * valid provenance alone is NOT payment evidence.
   */
  async saveSnapshotForged(
    worldId: string,
    snapshotText: string,
    meta: { runId?: string | null; tick: number; writerId: string },
  ): Promise<PersistedProvenance> {
    this.identityChecks(meta);
    return this.persist(worldId, snapshotText, meta, {});
  }

  private identityChecks(meta: { writerId: string }): void {
    if (typeof meta.writerId !== 'string' || meta.writerId.length === 0)
      throw new SnapshotProvenanceError('writerId is required and must be non-empty');
  }

  private sealChecks(
    worldId: string,
    snapshotText: string,
    meta: { writerId: string },
  ): VersionTuple {
    this.identityChecks(meta);
    const key = this.key();
    void key; // boot-time refusal when the HMAC key is unset
    return validateSnapshotText(snapshotText, { maxBytes: this.limit() });
  }

  private async persist(
    worldId: string,
    snapshotText: string,
    meta: { runId?: string | null; tick: number; writerId: string },
    versions: Partial<VersionTuple>,
  ): Promise<PersistedProvenance> {
    const key = this.key();
    const snapshotId = randomUUID();
    const nonce = generateNonce();
    const createdAt = new Date();
    const payloadSha256 = computePayloadSha256(snapshotText);
    const runId = meta.runId ?? null;
    const full: VersionTuple = {
      schema: versions.schema ?? NaN,
      engine: versions.engine ?? NaN,
      rules: versions.rules ?? NaN,
      canonical: versions.canonical ?? NaN,
      phase: versions.phase ?? NaN,
    };
    const hmac = computeProvenanceHmac(key, {
      snapshotId,
      worldId,
      runId,
      tick: meta.tick,
      createdAt: createdAt.toISOString(),
      payloadSha256,
      nonce,
    });
    const tuple = {
      schema: full.schema,
      engine: full.engine,
      rules: full.rules,
      canonical: full.canonical,
      phase: full.phase,
    };
    await this.db.transaction(async (tx) => {
      if (runId !== null) {
        // World-ownership integrity: the referenced run must exist in THIS
        // world. Enforced inside the write transaction so no rows are
        // published for a mismatched (worldId, runId) pairing.
        const owner = await tx
          .select({ worldId: runs.worldId })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!owner[0] || owner[0].worldId !== worldId)
          throw new SnapshotProvenanceError(
            `run ${runId} does not belong to world ${worldId}: cross-world snapshot write rejected`,
          );
      }
      await tx.insert(snapshots).values({
        snapshotId,
        worldId,
        runId,
        tick: meta.tick,
        payload: snapshotText,
        payloadSha256,
        versions: tuple,
        createdAt,
      });
      await tx.insert(snapshotProvenance).values({
        snapshotId,
        worldId,
        runId,
        tick: meta.tick,
        writerId: meta.writerId,
        payloadSha256,
        nonce,
        createdAt,
        versions: tuple,
        hmac,
      });
    });
    return {
      snapshotId,
      worldId,
      runId,
      tick: meta.tick,
      versions: tuple,
      createdAt: createdAt.toISOString(),
      writerId: meta.writerId,
      payloadSha256,
      nonce,
      hmac,
    };
  }

  /**
   * Full verification before bytes are returned: provenance first, then
   * structure. This method PERFORMS HMAC VERIFICATION — stored bytes are never
   * trusted on their own. It is the sole authenticated read path: an
   * `openRun` (or any run/snapshot identifier) is NOT standalone proof of
   * authenticated data, and importing snapshots from untrusted sources
   * (bypassing loadSnapshot) is never allowed — every restore must go
   * through this verified loader.
   */
  async loadSnapshot(
    worldId: string,
    snapshotId: string,
  ): Promise<{ text: string; provenance: PersistedProvenance }> {
    const key = this.key();
    const limit = this.limit();
    const rows = await this.db
      .select()
      .from(snapshots)
      .innerJoin(snapshotProvenance, eq(snapshots.snapshotId, snapshotProvenance.snapshotId))
      .where(eq(snapshots.snapshotId, snapshotId))
      .limit(1);
    const row = rows[0];
    if (!row || row.snapshots.worldId !== worldId)
      throw new SnapshotProvenanceError('snapshot not found for this world');
    const text = row.snapshots.payload;
    if (Buffer.byteLength(text, 'utf8') > limit) throw new SnapshotSizeError(limit);
    const payloadSha256 = computePayloadSha256(text);
    if (payloadSha256 !== row.snapshot_provenance.payloadSha256)
      throw new SnapshotProvenanceError('payload digest mismatch: stored bytes were tampered with');
    const hmac = computeProvenanceHmac(key, {
      snapshotId,
      worldId,
      runId: row.snapshot_provenance.runId,
      tick: row.snapshot_provenance.tick,
      createdAt: row.snapshot_provenance.createdAt.toISOString(),
      payloadSha256,
      nonce: row.snapshot_provenance.nonce,
    });
    if (hmac !== row.snapshot_provenance.hmac)
      throw new SnapshotProvenanceError('HMAC mismatch: wrong key or tampered provenance');
    const versions = validateSnapshotText(text, { maxBytes: limit });
    const provenance: PersistedProvenance = {
      snapshotId,
      worldId,
      runId: row.snapshot_provenance.runId,
      tick: row.snapshot_provenance.tick,
      versions,
      createdAt: row.snapshot_provenance.createdAt.toISOString(),
      writerId: row.snapshot_provenance.writerId,
      payloadSha256,
      nonce: row.snapshot_provenance.nonce,
      hmac: row.snapshot_provenance.hmac,
    };
    return { text, provenance };
  }
}

export function createSnapshotRepository(pool: Pool): SnapshotRepository {
  return new SnapshotRepository(pool);
}
