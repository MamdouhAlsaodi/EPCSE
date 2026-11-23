import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { canonical } from '@epcse/simulation-core';
import type { ThreeNationsFoodSubsidyComparison } from '../../packages/analytics/src/compare.js';
import { collectSubsidyTreasuryDebits } from '../../packages/analytics/src/compare.js';
import { createThreeNations } from '@epcse/scenarios';
import {
  createRunRepository,
  createSnapshotRepository,
  runMigrations,
} from '../../packages/persistence/src/index.js';

const DATABASE_URL = process.env.EPCSE_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);

async function runBuiltComparison(
  options: {
    seed?: number;
    counterfactualSetupVersion?: number;
  } = {},
): Promise<{
  text: string;
  value: ThreeNationsFoodSubsidyComparison;
}> {
  const script = `import { compareThreeNationsFoodSubsidy } from './packages/analytics/dist/index.js'; console.log(JSON.stringify(compareThreeNationsFoodSubsidy(${JSON.stringify(options)})))`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 1_200_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = stdout.trim();
  return { text, value: JSON.parse(text) as ThreeNationsFoodSubsidyComparison };
}

interface ThreeNationsDeterminismPayload {
  readonly stateHash: string;
  readonly eventHash: string;
  readonly invariants: { readonly moneyConserved: boolean; readonly moneyNonnegative: boolean };
}

/** Heavy canonical-hash runs execute in a child over the BUILT scenario entry (see m1.test.ts). */
async function runThreeNationsInChild(ticks: number): Promise<ThreeNationsDeterminismPayload> {
  const script = `import { runThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js'; const r = runThreeNations({ seed: 42, ticks: ${ticks} }); console.log(JSON.stringify({ stateHash: r.stateHash, eventHash: r.eventHash, invariants: r.invariants }));`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 3_000_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as ThreeNationsDeterminismPayload;
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

  it('opt-in counterfactual setup v1 produces a real policy-funded payment with nonzero economic effect', async () => {
    const { value: result } = await runBuiltComparison({
      seed: 42,
      counterfactualSetupVersion: 1,
    });
    expect(result.initialBranchSnapshotsIdentical).toBe(true);
    expect(result.sourceSnapshotUnchanged).toBe(true);
    expect(result.conservation).toEqual({ a: true, b: true });
    expect(result.policy.receipt.status).toBe('applied');
    expect(result.policy.fundedGuarantee).toBe(10);
    // RED: the policy must actually pay against a real purchase (not just apply).
    expect(result.policy.payment).not.toBeNull();
    expect(result.policy.payment!.amount).toBeGreaterThan(0);
    // treasuryDebit aggregates EVERY qualifying treasury debit; payment is the first.
    expect(result.policy.paymentCount).toBeGreaterThanOrEqual(1);
    expect(result.policy.treasuryDebit).toBe(result.policy.payment!.amount);
    expect(result.policy.treasuryDebit).toBeLessThanOrEqual(result.policy.fundedGuarantee);
    // The payment must move real money: plains treasury lower in A than B.
    expect(result.deltaAminusB.kingdoms.plains!.treasury).toBeLessThan(0);
    // Relevant economic effect: the treasury debit leaves the kingdom treasuries exactly.
    expect(result.deltaAminusB.world.treasury).toBe(-result.policy.treasuryDebit);
    expect(result.setup).toMatchObject({ version: 1 });
    expect(result.baseline.tick).toBe(200);
    expect(result.a.tick).toBe(300);
  }, 1_800_000);

  it('default fixture stays honest: no purchasable food or funding means no policy payment', async () => {
    const { value: result } = await runBuiltComparison({ seed: 42 });
    expect(result.policy.receipt.status).toBe('applied');
    // RED: default tick-200 state has zero resident cash and an empty seller supply,
    // so no purchase occurs and the policy honestly pays nothing.
    expect(result.policy.payment).toBeNull();
    expect(result.policy.treasuryDebit).toBe(0);
    expect(result.deltaAminusB.world.treasury).toBe(0);
    expect(result.conservation).toEqual({ a: true, b: true });
  }, 1_800_000);

  it('default fixture matches pre-change canonical state/event hashes and the pre-change tick-0 snapshot', async () => {
    // Pins generated BEFORE the opt-in SC-16 setup existed. The 1000-tick state/event
    // hashes are the authoritative canonical pins from tests/integration/m1.test.ts
    // ('SC-15 regression'). The tick-0 snapshot sha256 was measured against the real
    // pre-change fixture code (git HEAD 1054af0 built in isolation) in this session:
    //   sha256(canonical(createThreeNations({seed:42,ticks:300}).engine.snapshotText()))
    // A default-path regression would fail all three pins; the opt-in setup cannot
    // affect them because it is applied only when the option is passed.
    const pinnedStateHash = 'f7052866af0c7dc663aa4c12e256c3f3defda957b31ddd81346dc9a4372b12de';
    const pinnedEventHash = 'af179ccaea4845026a76e10e033310b17a83aee654cad9d2703da28bc7c5182e';
    const pinnedTick0Sha256 = '55a2ebf2c395c10f8043fe5822122f6d0281c7d935f684e53d1e4a6baf0e4f24';

    // Tick-0 snapshot of the default fixture over the current build.
    const tick0 = createThreeNations({ seed: 42, ticks: 300 }).engine.snapshotText();
    expect(createHash('sha256').update(canonical(tick0)).digest('hex')).toBe(pinnedTick0Sha256);

    // Full canonical state/events at tick 1000 over the built default scenario.
    const a = await runThreeNationsInChild(1000);
    expect(a.stateHash).toBe(pinnedStateHash);
    expect(a.eventHash).toBe(pinnedEventHash);
    expect(a.invariants.moneyConserved).toBe(true);
  }, 3_300_000);

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
  it('saves/loads the opt-in tick-200 snapshot, runs both branches 100 ticks with an identical schedule and an A-only policy, and reconciles the real payment', async () => {
    process.env.EPCSE_SNAPSHOT_HMAC_KEY ??= 't19-integration-test-key';
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      await runMigrations(pool);
      const runs = createRunRepository(pool);
      const snapshots = createSnapshotRepository(pool);
      snapshots.setMaxBytes(64 * 1024 * 1024);
      const worldId = `sc16-${randomUUID()}`;
      const seed = 42;
      // Opt-in SC-16 setup v1: the tick-200 snapshot already contains naturally
      // sustained purchasable food and resident funding common to both branches.
      const source = createThreeNations({ seed, ticks: 300, counterfactualSetupVersion: 1 });
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
      const loadedText = (await snapshots.loadSnapshot(worldId, stored.snapshotId)).text;
      expect(loadedText).toBe(text);
      expect(loadedText.length).toBeGreaterThan(0);

      const aRun = await runs.openRun(worldId, {
        seed,
        parentRunId: parent.runId,
        baseSnapshotId: stored.snapshotId,
      });
      const bRun = await runs.openRun(worldId, {
        seed,
        parentRunId: parent.runId,
        baseSnapshotId: stored.snapshotId,
      });
      // Both branch engines are built with the SAME options as the source
      // fixture (including the opt-in counterfactualSetupVersion) so fork
      // configs match; restore() then overlays the identical tick-200 state.
      const a = createThreeNations({
        seed,
        ticks: 300,
        counterfactualSetupVersion: 1,
      }).engine;
      a.restore(loadedText);
      expect(a.snapshotText()).toBe(text);
      const b = createThreeNations({
        seed,
        ticks: 300,
        counterfactualSetupVersion: 1,
      }).engine;
      b.restore(loadedText);
      expect(b.snapshotText()).toBe(text);
      expect(await runs.listCommands(bRun.runId)).toEqual([]);
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
      // Both branches run the SAME 100-tick schedule from the loaded opt-in tick-200
      // snapshot; only A received the policy command. Tick-by-tick advancement keeps
      // schedule submission order identical in both branches.
      a.submit(aPolicy);
      for (let tick = 201; tick <= 300; tick++) {
        const scheduled = source.commandsForTick(tick);
        for (const command of scheduled) {
          a.submit(command);
          b.submit(command);
        }
        a.run(1);
        b.run(1);
        if (tick % 10 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(a.receipts().find((item) => item.commandId === aPolicy.commandId)?.status).toBe(
        'applied',
      );

      // REAL payment evidence: the policy actually paid against purchases in A, and the
      // AGGREGATE treasury debit reconciles exactly against the A-vs-B treasury gap.
      const accountingA = a.getState().domain.accounting as Record<string, unknown>;
      const debits = collectSubsidyTreasuryDebits(accountingA.journal, 'sc16-db-policy');
      expect(debits.length).toBeGreaterThanOrEqual(1);
      expect(debits.every((effect) => effect.amount > 0)).toBe(true);
      const totalDebit = debits.reduce((sum, effect) => sum + effect.amount, 0);
      const treasuryBalance = (engine: typeof a) =>
        (
          (engine.getState().domain.accounting as Record<string, unknown>).accounts as Array<{
            id: string;
            balance: number;
          }>
        ).find((account) => account.id === 'plains-treasury')!.balance;
      expect(treasuryBalance(b) - treasuryBalance(a)).toBe(totalDebit);
      // Conservation in BOTH branches: nonnegative balances and money == opening money.
      for (const engine of [a, b]) {
        const accounting = engine.getState().domain.accounting as Record<string, unknown>;
        const accounts = accounting.accounts as Array<{ balance: number }>;
        const opening = accounting.openingBalances as Array<{ balance: number }>;
        expect(accounts.every((account) => account.balance >= 0)).toBe(true);
        expect(accounts.reduce((sum, account) => sum + account.balance, 0)).toBe(
          opening.reduce((sum, account) => sum + account.balance, 0),
        );
      }

      const aSaved = await snapshots.saveSnapshot(worldId, a.snapshotText(), {
        runId: aRun.runId,
        tick: 300,
        writerId: 'sc16-test',
      });
      const bSaved = await snapshots.saveSnapshot(worldId, b.snapshotText(), {
        runId: bRun.runId,
        tick: 300,
        writerId: 'sc16-test',
      });
      expect((await snapshots.loadSnapshot(worldId, aSaved.snapshotId)).text).toBe(
        a.snapshotText(),
      );
      expect((await snapshots.loadSnapshot(worldId, bSaved.snapshotId)).text).toBe(
        b.snapshotText(),
      );
      // Isolation: distinct diverged branch states, disjoint command rows, provenance
      // links intact, and the source engine's snapshot untouched by the forks.
      expect(aSaved.snapshotId).not.toBe(bSaved.snapshotId);
      expect(a.snapshotText()).not.toBe(b.snapshotText());
      expect(b.receipts().find((item) => item.commandId === aPolicy.commandId)).toBeUndefined();
      expect((await runs.listCommands(aRun.runId)).map((c) => c.commandId)).toEqual([
        'a-only-policy',
      ]);
      expect(await runs.listCommands(bRun.runId)).toEqual([]);
      expect(source.engine.snapshotText()).toBe(text);
      expect((await runs.getRun(aRun.runId))?.baseSnapshotId).toBe(stored.snapshotId);
      expect((await runs.getRun(bRun.runId))?.baseSnapshotId).toBe(stored.snapshotId);
      await runs.closeRun(aRun.runId);
      await runs.closeRun(bRun.runId);
      await runs.closeRun(parent.runId);
    } finally {
      await pool.end();
    }
  }, 3_600_000);
});
