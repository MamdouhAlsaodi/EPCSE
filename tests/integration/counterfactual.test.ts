import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ThreeNationsFoodSubsidyComparison } from '../../packages/analytics/src/compare.js';
import { createThreeNations } from '@epcse/scenarios';
import {
  createRunRepository,
  createSnapshotRepository,
  runMigrations,
} from '../../packages/persistence/src/index.js';

const DATABASE_URL = process.env.EPCSE_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);

async function runBuiltComparison(): Promise<{
  text: string;
  value: ThreeNationsFoodSubsidyComparison;
}> {
  const script =
    "import { compareThreeNationsFoodSubsidy } from './packages/analytics/dist/index.js'; console.log(JSON.stringify(compareThreeNationsFoodSubsidy({seed:42})))";
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 1_200_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = stdout.trim();
  return { text, value: JSON.parse(text) as ThreeNationsFoodSubsidyComparison };
}

describe('SC-16 three-nations food-subsidy counterfactual', () => {
  it('forks an identical full tick-200 state, applies funded policy only in A, and compares outcomes', async () => {
    const { text, value: result } = await runBuiltComparison();
    const repeated = await runBuiltComparison();
    expect(repeated.text).toBe(text);
    expect(result.label).toMatch(/model outcomes/i);
    expect(result.baseline.tick).toBe(200);
    expect(result.a.tick).toBe(300);
    expect(result.b.tick).toBe(300);
    expect(result.baselineVersions).toMatchObject({ schema: 1, engine: 1, rules: 1, metrics: 2 });
    expect(result.initialBranchSnapshotsIdentical).toBe(true);
    expect(result.sourceSnapshotUnchanged).toBe(true);
    expect(result.policy.receipt.status).toBe('applied');
    expect(result.policy.fundedGuarantee).toBe(10);
    expect(result.policy.payment === null || result.policy.payment.amount > 0).toBe(true);
    expect(result.policy.treasuryDebit).toBe(result.policy.payment?.amount ?? 0);
    expect(result.deltaAminusB.cities['plain-central']?.prices.grain).toEqual(expect.any(Number));
    expect(result.deltaAminusB.kingdoms.plains?.staplePrice).toEqual(expect.any(Number));
    expect(result.deltaAminusB.world.treasury).toEqual(expect.any(Number));
    expect(result.deltaAminusB.politics.satisfactionByGroup).toBeDefined();
    expect(result.deltaAminusB.world.unmet).toEqual(expect.any(Number));
    expect(result.deltaAminusB.world.departed).toEqual(expect.any(Number));
    expect(result.deltaAfromBaseline.world.treasury).toEqual(expect.any(Number));
    expect(result.deltaBfromBaseline.world.treasury).toEqual(expect.any(Number));
    expect(result.conservation).toEqual({ a: true, b: true });
  }, 1_800_000);

  it('refuses incompatible engine and rules versions before comparing', () => {
    const fixture = createThreeNations({ seed: 42, ticks: 300 });
    const snapshot = fixture.engine.snapshot();
    const mismatch = (change: (s: typeof snapshot) => void) => {
      const changed = structuredClone(snapshot);
      change(changed);
      return () => fixture.engine.restore(changed);
    };
    expect(mismatch((s) => ((s as { engineVersion: number }).engineVersion = 99))).toThrow(
      /version/i,
    );
    expect(mismatch((s) => ((s as { rulesVersion: number }).rulesVersion = 99))).toThrow(
      /version/i,
    );
    expect(() => fixture.engine.restore(snapshot)).not.toThrow();
  });
});

describe.skipIf(!DATABASE_URL)('SC-16 persisted fork (real PostgreSQL)', () => {
  it('loads a full tick-200 snapshot into isolated branch engines and retains provenance', async () => {
    process.env.EPCSE_SNAPSHOT_HMAC_KEY ??= 't19-integration-test-key';
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      await runMigrations(pool);
      const runs = createRunRepository(pool);
      const snapshots = createSnapshotRepository(pool);
      snapshots.setMaxBytes(64 * 1024 * 1024);
      const worldId = `sc16-${randomUUID()}`;
      const seed = 42;
      const source = createThreeNations({ seed, ticks: 300 });
      for (let i = 0; i < 200; i++) {
        source.engine.run(1);
        if (i % 10 === 9) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const text = source.engine.snapshotText();
      const parent = await runs.openRun(worldId, { seed });
      const stored = await snapshots.saveSnapshot(worldId, text, {
        runId: parent.runId,
        tick: 200,
        writerId: 'sc16-test',
      });
      const loaded = await snapshots.loadSnapshot(worldId, stored.snapshotId);
      expect(loaded.text).toBe(text);
      expect(loaded.provenance.payloadSha256).toBe(stored.payloadSha256);
      expect(loaded.provenance.writerId).toBe('sc16-test');

      const aRun = await runs.openRun(worldId, {
        seed,
        parentRunId: parent.runId,
        baseSnapshotId: stored.snapshotId,
      });
      const a = createThreeNations({ seed, ticks: 300 }).engine;
      a.restore(loaded.text);
      expect(a.snapshotText()).toBe(text);
      const aPolicy = {
        commandId: 'a-only-policy',
        type: 'government.policy',
        requestedTick: 201,
        payload: {
          kingdomId: 'plains',
          governmentId: 'plains',
          variant: 'food-subsidy',
          policyId: 'sc16-db-policy',
          recipientKingdomId: 'plains',
          recipientOwnerId: 'plain-central-residents',
          recipientAccountId: 'plain-central-residents-cash',
          commodity: 'grain',
          amount: 10,
          effectiveTick: 204,
          expiryTick: 300,
          legitimacy: 80,
          quorum: 0,
          support: 80,
          oppositionVeto: false,
        },
      };
      await runs.appendCommand(aRun.runId, aPolicy.commandId, aPolicy);
      a.submit(aPolicy);
      a.run(1);
      expect(a.receipts().find((item) => item.commandId === aPolicy.commandId)?.status).toBe(
        'applied',
      );
      await runs.closeRun(aRun.runId);

      const bRun = await runs.openRun(worldId, {
        seed,
        parentRunId: parent.runId,
        baseSnapshotId: stored.snapshotId,
      });
      const b = createThreeNations({ seed, ticks: 300 }).engine;
      b.restore((await snapshots.loadSnapshot(worldId, stored.snapshotId)).text);
      expect(b.snapshotText()).toBe(text);
      expect(await runs.listCommands(bRun.runId)).toEqual([]);
      expect((await runs.listCommands(aRun.runId)).map((c) => c.commandId)).toEqual([
        'a-only-policy',
      ]);
      b.run(1);
      const aSaved = await snapshots.saveSnapshot(worldId, a.snapshotText(), {
        runId: aRun.runId,
        tick: 201,
        writerId: 'sc16-test',
      });
      const bSaved = await snapshots.saveSnapshot(worldId, b.snapshotText(), {
        runId: bRun.runId,
        tick: 201,
        writerId: 'sc16-test',
      });
      expect((await snapshots.loadSnapshot(worldId, aSaved.snapshotId)).text).toBe(
        a.snapshotText(),
      );
      expect((await snapshots.loadSnapshot(worldId, bSaved.snapshotId)).text).toBe(
        b.snapshotText(),
      );
      expect(aSaved.snapshotId).not.toBe(bSaved.snapshotId);
      expect(a.snapshotText()).not.toBe(b.snapshotText());
      expect(b.receipts().find((item) => item.commandId === aPolicy.commandId)).toBeUndefined();
      expect(source.engine.snapshotText()).toBe(text);
      expect((await runs.getRun(aRun.runId))?.baseSnapshotId).toBe(stored.snapshotId);
      expect((await runs.getRun(bRun.runId))?.baseSnapshotId).toBe(stored.snapshotId);
      await runs.closeRun(bRun.runId);
      await runs.closeRun(parent.runId);
    } finally {
      await pool.end();
    }
  }, 1_800_000);
});
