import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { canonical, createEngine, type Engine } from '@epcse/simulation-core';
import {
  RunConflictError,
  SnapshotIncompatibleError,
  SnapshotProvenanceError,
  SnapshotSizeError,
  computePayloadSha256,
  runMigrations,
  createSnapshotRepository,
  createRunRepository,
} from '../../packages/persistence/src/index.js';
import type {
  SnapshotStore,
  RunStore,
  PersistedProvenance as PortProvenance,
} from '../../packages/simulation-core/src/ports/persistence.js';
import type { SnapshotRepository, RunRepository } from '../../packages/persistence/src/index.js';

type AssertAssignable<T extends U, U> = [T] extends [U] ? true : false;
// Structural conformance to the protected port (cross-package import of the
// port type is unavailable under the packet allowlist; types mirror it).
type _SnapshotStoreConformance = AssertAssignable<SnapshotRepository, SnapshotStore>;
type _RunStoreConformance = AssertAssignable<RunRepository, RunStore>;
type _ProvenanceConformance = AssertAssignable<
  import('../../packages/persistence/src/index.js').PersistedProvenance,
  PortProvenance
>;
type _Used = [_SnapshotStoreConformance, _RunStoreConformance, _ProvenanceConformance];
export type { _Used };

const TEST_HMAC_KEY = 't17-integration-test-key';
const DATABASE_URL = process.env.EPCSE_TEST_DATABASE_URL;

process.env.EPCSE_SNAPSHOT_HMAC_KEY = TEST_HMAC_KEY;

/** Engine-shaped versioned snapshot text (valid structural candidate). */
function snapText(tick = 0, domain: Record<string, unknown> = {}): string {
  return canonical({
    schemaVersion: 1,
    engineVersion: 1,
    rulesVersion: 1,
    canonicalVersion: 1,
    phaseVersion: 1,
    tick,
    domain,
  });
}

function scenario(): Engine {
  const engine = createEngine({ worldId: 'sim', initialState: { value: 0, draws: [] } }, 7);
  engine.registerPhaseSystem('production', 'daily', (draft, random) => {
    draft.value = (draft.value as number) + 1;
    (draft.draws as number[]).push(Math.floor(random() * 100));
  });
  return engine;
}

const db = DATABASE_URL ? { pool: new Pool({ connectionString: DATABASE_URL }) } : { pool: null };

describe.skipIf(db.pool === null)('persistence integration (real PostgreSQL)', () => {
  let snapshots: SnapshotRepository;
  let runs: RunRepository;
  let pool: Pool;

  beforeAll(async () => {
    pool = db.pool!;
    await runMigrations(pool);
    snapshots = createSnapshotRepository(pool);
    runs = createRunRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE run_commands, runs, snapshot_provenance, snapshots CASCADE');
    snapshots.setHmacKey(undefined);
    snapshots.setMaxBytes(undefined);
  });

  afterAll(async () => {
    await db.pool?.end();
  });

  async function rowCount(table: string): Promise<number> {
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0]!.n as number;
  }

  it('roundtrips a snapshot byte-for-byte with full provenance', async () => {
    const engine = scenario();
    engine.run(3);
    const text = engine.snapshotText();
    const run = await runs.openRun('w-roundtrip', { seed: 7 });
    const saved = await snapshots.saveSnapshot('w-roundtrip', text, {
      runId: run.runId,
      tick: 3,
      writerId: 'writer-1',
    });
    const loaded = await snapshots.loadSnapshot('w-roundtrip', saved.snapshotId);
    expect(loaded.text).toBe(text);
    expect(loaded.provenance.writerId).toBe('writer-1');
    expect(loaded.provenance.payloadSha256).toBe(computePayloadSha256(text));
    expect(loaded.provenance.nonce).toBeTruthy();
    expect(loaded.provenance.createdAt).toBeTruthy();
    expect(loaded.provenance.hmac).toMatch(/^[0-9a-f]{64}$/);
    await runs.closeRun(run.runId);
  });

  it('rejects a tampered payload with SnapshotProvenanceError', async () => {
    const saved = await snapshots.saveSnapshot('w-tamper', snapText(1), {
      tick: 1,
      writerId: 'writer-1',
    });
    // wrong worldId lookup is also a provenance failure
    await expect(snapshots.loadSnapshot('w-other', saved.snapshotId)).rejects.toBeInstanceOf(
      SnapshotProvenanceError,
    );
    // direct DB tampering is detected by the HMAC over the payload digest
    await pool.query('UPDATE snapshots SET payload = $1 WHERE snapshot_id = $2', [
      canonical({ tick: 999 }),
      saved.snapshotId,
    ]);
    await expect(snapshots.loadSnapshot('w-tamper', saved.snapshotId)).rejects.toBeInstanceOf(
      SnapshotProvenanceError,
    );
  });

  it('rejects a record sealed with a different HMAC key', async () => {
    const saved = await snapshots.saveSnapshot('w-key', snapText(1), {
      tick: 1,
      writerId: 'writer-1',
    });
    snapshots.setHmacKey('a-different-test-key');
    await expect(snapshots.loadSnapshot('w-key', saved.snapshotId)).rejects.toBeInstanceOf(
      SnapshotProvenanceError,
    );
    snapshots.setHmacKey(TEST_HMAC_KEY);
  });

  it('rejects oversize snapshots with SnapshotSizeError before any DB write', async () => {
    snapshots.setMaxBytes(64);
    const before = await rowCount('snapshots');
    const big = canonical({ tick: 0, domain: { blob: 'x'.repeat(200) } });
    await expect(
      snapshots.saveSnapshot('w-size', big, { tick: 0, writerId: 'writer-1' }),
    ).rejects.toBeInstanceOf(SnapshotSizeError);
    expect(await rowCount('snapshots')).toBe(before);
    snapshots.setMaxBytes(8 * 1024 * 1024);
  });

  it('rejects a valid-MAC record with an incompatible version tuple', async () => {
    const run = await runs.openRun('w-version', { seed: 7 });
    const forgedText = canonical({
      schemaVersion: 1,
      engineVersion: 2,
      rulesVersion: 1,
      canonicalVersion: 1,
      phaseVersion: 1,
      tick: 0,
      domain: {},
    });
    await snapshots.saveSnapshotForged('w-version', forgedText, {
      runId: run.runId,
      tick: 0,
      writerId: 'writer-1',
    });
    const rows = await pool.query(
      'SELECT snapshot_id FROM snapshots WHERE world_id = $1 ORDER BY created_at DESC LIMIT 1',
      ['w-version'],
    );
    const id = rows.rows[0]!.snapshot_id as string;
    await expect(snapshots.loadSnapshot('w-version', id)).rejects.toBeInstanceOf(
      SnapshotIncompatibleError,
    );
    await runs.closeRun(run.runId);
  });

  it('enforces one active run per world, reopen after close, and command replay isolation', async () => {
    const first = await runs.openRun('w-runs', { seed: 1 });
    await expect(runs.openRun('w-runs', { seed: 1 })).rejects.toBeInstanceOf(RunConflictError);
    await runs.appendCommand(first.runId, 'cmd-1', { type: 'transfer', amount: 1 });
    await expect(
      runs.appendCommand(first.runId, 'cmd-1', { type: 'transfer', amount: 2 }),
    ).rejects.toBeInstanceOf(RunConflictError);
    const other = await runs.openRun('w-runs-2', { seed: 1 });
    await runs.appendCommand(other.runId, 'cmd-1', { type: 'transfer', amount: 3 });
    expect((await runs.listCommands(first.runId)).length).toBe(1);
    expect((await runs.listCommands(other.runId)).length).toBe(1);
    await runs.closeRun(first.runId);
    const reopened = await runs.openRun('w-runs', { seed: 1 });
    expect(reopened.runId).not.toBe(first.runId);
    await runs.closeRun(reopened.runId);
    await runs.closeRun(other.runId);
  });

  it('keeps a branched run disjoint from its parent (SC-16 storage half)', async () => {
    const parent = await runs.openRun('w-branch', { seed: 7 });
    const engine = scenario();
    engine.run(60);
    const snap = await snapshots.saveSnapshot('w-branch', engine.snapshotText(), {
      runId: parent.runId,
      tick: 60,
      writerId: 'writer-1',
    });
    await runs.appendCommand(parent.runId, 'parent-cmd', { type: 'transfer', amount: 5 });
    const branch = await runs.openRun('w-branch', {
      seed: 7,
      parentRunId: parent.runId,
      baseSnapshotId: snap.snapshotId,
    });
    expect(branch.parentRunId).toBe(parent.runId);
    expect(branch.baseSnapshotId).toBe(snap.snapshotId);
    await runs.appendCommand(branch.runId, 'branch-cmd', { type: 'transfer', amount: 9 });
    const parentCommands = await runs.listCommands(parent.runId);
    const branchCommands = await runs.listCommands(branch.runId);
    expect(parentCommands.map((c) => c.commandId)).toEqual(['parent-cmd']);
    expect(branchCommands.map((c) => c.commandId)).toEqual(['branch-cmd']);
    const parentAfter = await runs.getRun(parent.runId);
    // Explicit branch moved the parent out of 'active'; its data is untouched.
    expect(parentAfter?.status).toBe('branched');
    expect(parentAfter?.parentRunId).toBeNull();
    expect(parentAfter?.baseSnapshotId).toBeNull();
    await runs.closeRun(parent.runId);
    await runs.closeRun(branch.runId);
  });

  it('publishes nothing when the provenance insert fails (atomic write)', async () => {
    const beforeSnapshots = await rowCount('snapshots');
    const beforeProvenance = await rowCount('snapshot_provenance');
    // writerId passes in-memory validation but violates the DB CHECK -> second insert fails
    const longWriter = 'w'.repeat(200);
    await expect(
      snapshots.saveSnapshot('w-atomic', snapText(0), {
        tick: 0,
        writerId: longWriter,
      }),
    ).rejects.toThrow();
    expect(await rowCount('snapshots')).toBe(beforeSnapshots);
    expect(await rowCount('snapshot_provenance')).toBe(beforeProvenance);
  });

  it('commits two racing saves fully with distinct snapshot ids and no partial rows', async () => {
    const textA = snapText(1, { tag: 'a' });
    const textB = snapText(2, { tag: 'b' });
    const [a, b] = await Promise.all([
      snapshots.saveSnapshot('w-race', textA, { tick: 1, writerId: 'writer-a' }),
      snapshots.saveSnapshot('w-race', textB, { tick: 2, writerId: 'writer-b' }),
    ]);
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect((await snapshots.loadSnapshot('w-race', a.snapshotId)).text).toBe(textA);
    expect((await snapshots.loadSnapshot('w-race', b.snapshotId)).text).toBe(textB);
  });

  it('restores from a stored snapshot and continues identically (SC-15 over real DB)', async () => {
    const continuous = scenario();
    continuous.run(120);

    const first = scenario();
    first.run(60);
    const saved = await snapshots.saveSnapshot('w-restore', first.snapshotText(), {
      tick: 60,
      writerId: 'writer-1',
    });
    const resumed = scenario();
    const loaded = await snapshots.loadSnapshot('w-restore', saved.snapshotId);
    resumed.restore(loaded.text);
    resumed.run(60);

    expect(resumed.snapshotText()).toBe(continuous.snapshotText());
    expect(resumed.getState().hash).toBe(continuous.getState().hash);
    expect(resumed.getState().eventHash).toBe(continuous.getState().eventHash);
  });

  it('never treats stored provenance as payment evidence (trust boundary)', async () => {
    // Forged content, but written by a *trusted* writer with a VALID provenance record:
    // the forgery claims an in-world payment via domain.treasury.
    const run = await runs.openRun('w-money', { seed: 7 });
    const forged = canonical({
      schemaVersion: 1,
      engineVersion: 1,
      rulesVersion: 1,
      canonicalVersion: 1,
      phaseVersion: 1,
      tick: 200,
      domain: { treasury: 999999999, paymentsReceived: ['forged-payment'] },
      seed: 7,
      queue: [],
      receipts: [],
      envelopes: [],
      events: [],
      nextSequence: 1,
      nextEventId: 1,
      rngState: 7,
      config: { worldId: 'w-money', initialState: {} },
      paused: false,
    });
    await snapshots.saveSnapshotForged('w-money', forged, {
      runId: run.runId,
      tick: 200,
      writerId: 'writer-1',
    });
    const rows = await pool.query(
      'SELECT snapshot_id FROM snapshots WHERE world_id = $1 ORDER BY created_at DESC LIMIT 1',
      ['w-money'],
    );
    const id = rows.rows[0]!.snapshot_id as string;
    const loaded = await snapshots.loadSnapshot('w-money', id);
    // The forged treasury value survives only as opaque bytes...
    expect(JSON.parse(loaded.text).domain.treasury).toBe(999999999);
    // ...and provenance metadata is exactly who/when/what — NO payment evidence claim.
    expect(Object.keys(loaded.provenance).sort()).toEqual([
      'createdAt',
      'hmac',
      'nonce',
      'payloadSha256',
      'runId',
      'snapshotId',
      'tick',
      'versions',
      'worldId',
      'writerId',
    ]);
    // No payment evidence exists anywhere: the run has no command rows.
    expect(await runs.listCommands(run.runId)).toEqual([]);
    // And the API cannot claim otherwise: provenance carries no payments/ledger fields.
    const meta = JSON.stringify(loaded.provenance);
    expect(meta).not.toContain('payment');
    expect(meta).not.toContain('treasury');
    expect(meta).not.toContain('ledger');
    await runs.closeRun(run.runId);
  });

  it('requires a non-empty writerId', async () => {
    await expect(
      snapshots.saveSnapshot('w-writer', snapText(0), {
        tick: 0,
        writerId: '',
      }),
    ).rejects.toBeInstanceOf(SnapshotProvenanceError);
  });

  it('fails at write time when no HMAC key is configured', async () => {
    const previous = process.env.EPCSE_SNAPSHOT_HMAC_KEY;
    delete process.env.EPCSE_SNAPSHOT_HMAC_KEY;
    try {
      await expect(
        snapshots.saveSnapshot('w-nokey', snapText(0), {
          tick: 0,
          writerId: 'writer-1',
        }),
      ).rejects.toBeInstanceOf(SnapshotProvenanceError);
    } finally {
      process.env.EPCSE_SNAPSHOT_HMAC_KEY = previous;
    }
  });
});

if (!DATABASE_URL) {
  describe('persistence integration (skipped)', () => {
    it('skips when EPCSE_TEST_DATABASE_URL is unset (CI has no DB service)', () => {
      expect(DATABASE_URL).toBeUndefined();
    });
  });
}
