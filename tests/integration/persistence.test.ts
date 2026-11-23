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
  MIGRATIONS,
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

  it('admits two concurrently-active sibling branches of one parent (T19 SC-16)', async () => {
    const parent = await runs.openRun('w-siblings', { seed: 7 });
    const engine = scenario();
    engine.run(30);
    const snap = await snapshots.saveSnapshot('w-siblings', engine.snapshotText(), {
      runId: parent.runId,
      tick: 30,
      writerId: 'writer-1',
    });
    const a = await runs.openRun('w-siblings', {
      seed: 7,
      parentRunId: parent.runId,
      baseSnapshotId: snap.snapshotId,
    });
    // Second sibling must NOT raise RunConflictError (0002 narrows the unique
    // index to primary runs; both branches share the same world).
    const b = await runs.openRun('w-siblings', {
      seed: 7,
      parentRunId: parent.runId,
      baseSnapshotId: snap.snapshotId,
    });
    expect(b.runId).not.toBe(a.runId);
    expect(b.parentRunId).toBe(parent.runId);
    expect(b.baseSnapshotId).toBe(snap.snapshotId);
    // Siblings are isolated: disjoint command logs for the same commandId.
    await runs.appendCommand(a.runId, 'shared-cmd', { type: 'transfer', amount: 1 });
    await runs.appendCommand(b.runId, 'shared-cmd', { type: 'transfer', amount: 2 });
    await runs.appendCommand(b.runId, 'b-only-cmd', { type: 'transfer', amount: 3 });
    await expect(
      runs.appendCommand(b.runId, 'b-only-cmd', { type: 'transfer', amount: 4 }),
    ).rejects.toBeInstanceOf(RunConflictError);
    expect((await runs.listCommands(a.runId)).map((c) => c.commandId)).toEqual(['shared-cmd']);
    expect((await runs.listCommands(b.runId)).map((c) => c.commandId)).toEqual([
      'shared-cmd',
      'b-only-cmd',
    ]);
    // Exactly one active PRIMARY run is still enforced even while branches exist.
    const primary = await runs.openRun('w-siblings-primary', { seed: 1 });
    await expect(runs.openRun('w-siblings-primary', { seed: 1 })).rejects.toBeInstanceOf(
      RunConflictError,
    );
    await runs.closeRun(primary.runId);
    await runs.closeRun(a.runId);
    await runs.closeRun(b.runId);
    await runs.closeRun(parent.runId);
  });

  it('rejects foreign base snapshots and mismatched parent/snapshot pairings', async () => {
    const parent = await runs.openRun('w-foreign', { seed: 7 });
    const engine = scenario();
    engine.run(10);
    const snap = await snapshots.saveSnapshot('w-foreign', engine.snapshotText(), {
      runId: parent.runId,
      tick: 10,
      writerId: 'writer-1',
    });
    const otherWorld = await runs.openRun('w-foreign-other', { seed: 7 });
    const otherSnap = await snapshots.saveSnapshot('w-foreign-other', engine.snapshotText(), {
      runId: otherWorld.runId,
      tick: 10,
      writerId: 'writer-1',
    });
    // Foreign world: snapshot belongs to a different world.
    await expect(
      runs.openRun('w-foreign', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: otherSnap.snapshotId,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    // Foreign parent: snapshot written by a run that is not the named parent.
    await expect(
      runs.openRun('w-foreign', {
        seed: 7,
        parentRunId: otherWorld.runId,
        baseSnapshotId: snap.snapshotId,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    // Unknown base snapshot id.
    await expect(
      runs.openRun('w-foreign', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    // Half-specified branch options are invalid.
    await expect(
      runs.openRun('w-foreign', { seed: 7, parentRunId: parent.runId }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await expect(
      runs.openRun('w-foreign', { seed: 7, baseSnapshotId: snap.snapshotId }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await runs.closeRun(parent.runId);
    await runs.closeRun(otherWorld.runId);
  });

  it('rolls back the parent branch transition when the fork insert fails (atomicity)', async () => {
    const parent = await runs.openRun('w-atomic-branch', { seed: 7 });
    // Force a failure INSIDE the branch transaction after the parent status
    // update is staged: the base snapshot belongs to a foreign world, so the
    // validation (which runs after the UPDATE statement) throws.
    const foreignWorld = await runs.openRun('w-atomic-branch-other', { seed: 7 });
    const foreignSnap = await snapshots.saveSnapshot('w-atomic-branch-other', snapText(1), {
      runId: foreignWorld.runId,
      tick: 1,
      writerId: 'writer-1',
    });
    await expect(
      runs.openRun('w-atomic-branch', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: foreignSnap.snapshotId,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    // The parent must still be 'active': the staged status update rolled back.
    expect((await runs.getRun(parent.runId))?.status).toBe('active');
    // After rollback, the parent can still be branched for real.
    const engine = scenario();
    engine.run(5);
    const snap = await snapshots.saveSnapshot('w-atomic-branch', engine.snapshotText(), {
      runId: parent.runId,
      tick: 5,
      writerId: 'writer-1',
    });
    const branch = await runs.openRun('w-atomic-branch', {
      seed: 7,
      parentRunId: parent.runId,
      baseSnapshotId: snap.snapshotId,
    });
    expect((await runs.getRun(parent.runId))?.status).toBe('branched');
    await runs.closeRun(branch.runId);
    await runs.closeRun(parent.runId);
    await runs.closeRun(foreignWorld.runId);
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

  it('rejects a FORGED cross-world pairing: branching with a parent run from another world mutates nothing', async () => {
    const parent = await runs.openRun('w-forged-pair', { seed: 7 });
    const engine = scenario();
    engine.run(5);
    const snap = await snapshots.saveSnapshot('w-forged-pair', engine.snapshotText(), {
      runId: parent.runId,
      tick: 5,
      writerId: 'writer-1',
    });
    const attacker = await runs.openRun('w-forged-other', { seed: 7 });
    const runsBefore = await rowCount('runs');
    const snapshotsBefore = await rowCount('snapshots');
    // Parent exists but lives in a DIFFERENT world than requested: must be
    // rejected and no run inserted / parent transitioned.
    await expect(
      runs.openRun('w-forged-target', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: snap.snapshotId,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    expect(await rowCount('runs')).toBe(runsBefore);
    expect(await rowCount('snapshots')).toBe(snapshotsBefore);
    expect((await runs.getRun(parent.runId))?.status).toBe('active');
    // Same forged pairing via saveSnapshot: runId belongs to another world.
    await expect(
      snapshots.saveSnapshot('w-forged-target', snapText(1), {
        runId: parent.runId,
        tick: 1,
        writerId: 'writer-1',
      }),
    ).rejects.toBeInstanceOf(SnapshotProvenanceError);
    await expect(
      snapshots.saveSnapshotForged('w-forged-target', snapText(1), {
        runId: attacker.runId,
        tick: 1,
        writerId: 'writer-1',
      }),
    ).rejects.toBeInstanceOf(SnapshotProvenanceError);
    expect(await rowCount('snapshots')).toBe(snapshotsBefore);
    expect(await rowCount('snapshot_provenance')).toBe(snapshotsBefore);
    // Legitimate old usage (runId omitted) is still accepted.
    await snapshots.saveSnapshot('w-forged-target', snapText(0), {
      tick: 0,
      writerId: 'writer-1',
    });
    expect(await rowCount('snapshots')).toBe(snapshotsBefore + 1);
    await runs.closeRun(parent.runId);
    await runs.closeRun(attacker.runId);
  });

  it('serializes concurrent fresh migrations before the migrations table exists', async () => {
    // Isolated empty schema on the real test DB: unlike the main suite pool,
    // there is NO schema_migrations table before these six runners race.
    const schema = `t19_migrations_${process.pid}_${Date.now()}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const fresh = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 8,
    });
    try {
      const absent = await fresh.query('SELECT to_regclass($1) AS name', [
        `${schema}.schema_migrations`,
      ]);
      expect(absent.rows[0]?.name).toBeNull();
      const racing = await Promise.all(Array.from({ length: 6 }, () => runMigrations(fresh)));
      expect(racing).toHaveLength(6);
      const versions = await fresh.query(
        'SELECT version, count(*)::int AS n FROM schema_migrations GROUP BY version ORDER BY version',
      );
      expect(versions.rows).toEqual(
        MIGRATIONS.map((migration) => ({ version: migration.version, n: 1 })),
      );
      const idx = await fresh.query(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexname = 'runs_one_active_per_world'",
        [schema],
      );
      expect(idx.rows[0]!.n).toBe(1);
    } finally {
      await fresh.end();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('truly concurrently opens sibling branches: exactly one parent transition, both branches active, data intact', async () => {
    const parent = await runs.openRun('w-concurrent-sib', { seed: 7 });
    const engine = scenario();
    engine.run(10);
    const snap = await snapshots.saveSnapshot('w-concurrent-sib', engine.snapshotText(), {
      runId: parent.runId,
      tick: 10,
      writerId: 'writer-1',
    });
    // Race two sibling opens of the same parent at the exact same time.
    const [a, b] = await Promise.all([
      runs.openRun('w-concurrent-sib', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: snap.snapshotId,
      }),
      runs.openRun('w-concurrent-sib', {
        seed: 7,
        parentRunId: parent.runId,
        baseSnapshotId: snap.snapshotId,
      }),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(a.parentRunId).toBe(parent.runId);
    expect(b.parentRunId).toBe(parent.runId);
    // Both siblings concurrently active in the same world.
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');
    // Parent transitioned exactly once, still exists, data untouched.
    const parentAfter = await runs.getRun(parent.runId);
    expect(parentAfter?.status).toBe('branched');
    expect(parentAfter?.parentRunId).toBeNull();
    expect(parentAfter?.baseSnapshotId).toBeNull();
    // The parent is now 'branched', not active: one new active primary is
    // permitted alongside branches, but a SECOND active primary is rejected.
    const newPrimary = await runs.openRun('w-concurrent-sib', { seed: 7 });
    await expect(runs.openRun('w-concurrent-sib', { seed: 7 })).rejects.toBeInstanceOf(
      RunConflictError,
    );
    // Parent command log untouched by the raced forks.
    expect((await runs.listCommands(parent.runId)).map((c) => c.commandId)).toEqual([]);
    await runs.closeRun(newPrimary.runId);
    await runs.closeRun(a.runId);
    await runs.closeRun(b.runId);
    await runs.closeRun(parent.runId);
  });
});

if (!DATABASE_URL) {
  describe('persistence integration (skipped)', () => {
    it('skips when EPCSE_TEST_DATABASE_URL is unset (CI has no DB service)', () => {
      expect(DATABASE_URL).toBeUndefined();
    });
  });
}
