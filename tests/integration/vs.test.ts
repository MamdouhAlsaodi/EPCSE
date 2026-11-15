import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { run } from '../../apps/cli/src/main.js';
import { runVerticalSlice } from '../../packages/scenarios/src/vertical-slice.js';

describe('vertical-slice scenario', () => {
  it('runs an economic, government, and bilateral trade slice', () => {
    const first = runVerticalSlice({ seed: 42, ticks: 10 });
    expect(first.ticks).toBe(10);
    expect(first.kingdoms).toHaveLength(2);
    expect(first.cities.length).toBeGreaterThanOrEqual(2);
    expect(first.cities.length).toBeLessThanOrEqual(4);
    expect(first.commodities).toHaveLength(5);
    expect(first.cohorts.length).toBeGreaterThanOrEqual(2);
    expect(first.governments).toHaveLength(2);
    expect(first.road.cost).toBeGreaterThan(0);
    expect(first.road.duration).toBeGreaterThan(0);
    expect(first.intervention).toMatchObject({ funded: true, amount: expect.any(Number) });
    expect(first.playerDecision).toMatchObject({ accepted: true, source: 'player' });
    expect(first.aiDecision).toMatchObject({ accepted: expect.any(Boolean), source: 'ai' });
    expect(first.trade).toMatchObject({
      departed: expect.any(Number),
      arrived: expect.any(Number),
      paid: expect.any(Number),
      accountingBalanced: true,
    });
    expect(first.trade.departed).toBeGreaterThan(0);
    expect(first.trade.arrived).toBeGreaterThan(0);
    expect(first.trade.paid).toBeGreaterThan(0);
    expect(first.trade.fundedFreight).toBe(true);
    expect(first.intervention.treasuryDebit).toBe(10);
    expect(first.recurring.ticksObserved).toBe(10);
    expect(first.recurring.production).toBeGreaterThan(0);
    expect(first.recurring.consumption).toBeGreaterThan(0);
    expect(first.invariants).toMatchObject({ nonnegativeMoney: true, nonnegativeStock: true });
    expect(first.hashes.state).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hashes.events).toMatch(/^[a-f0-9]{64}$/);
    expect(
      run(['run', '--scenario', 'vertical-slice', '--seed', '42', '--ticks', '10']).join('\n'),
    ).toContain('State hash:');
  });

  it('runs the built CLI for 1000 ticks twice with identical state and event hashes', async () => {
    // The runner's event loop must stay responsive during the long engine calculation.
    // CI runs typecheck before test, which produces this real built entrypoint.
    const cli = promisify(execFile);
    const args = [
      'apps/cli/dist/main.js',
      'run',
      '--scenario',
      'vertical-slice',
      '--seed',
      '42',
      '--ticks',
      '1000',
    ];
    const first = (await cli(process.execPath, args, { timeout: 1800000 })).stdout;
    const second = (await cli(process.execPath, args, { timeout: 1800000 })).stdout;
    expect(first).toBe(second);
    expect(first).toContain('1000 ticks');
    expect(first).toContain('funded intervention paid (10 coin debited)');
    expect(first).toContain('1 departed, 1 arrived; freight paid 3 from funded benefit true');
    expect(first).toMatch(/State hash: [a-f0-9]{64}/);
    expect(first).toMatch(/Event hash: [a-f0-9]{64}/);
  }, 1800000);

  it('allows explicit alternate fixture values and rejects invalid configurations', () => {
    const report = runVerticalSlice({
      seed: 7,
      ticks: 10,
      commodities: ['food', 'timber', 'ore', 'cloth', 'salt'],
      cohorts: ['workers', 'merchants'],
      road: { cost: 4, duration: 2 },
    });
    expect(report.commodities).toEqual(['food', 'timber', 'ore', 'cloth', 'salt']);
    expect(report.road).toMatchObject({ cost: 4, duration: 2 });
    expect(report.trade.fundedFreight).toBe(true);
    const refused = runVerticalSlice({ ticks: 10, aiMinimumStock: 1 });
    expect(refused.aiDecision.accepted).toBe(false);
    expect(refused.trade.departed).toBe(0);
    const playerRefused = runVerticalSlice({ ticks: 10, playerChoice: 'refuse' });
    expect(playerRefused.playerDecision.accepted).toBe(false);
    expect(playerRefused.trade.departed).toBe(0);
    expect(() => runVerticalSlice({ commodities: ['grain', 'wood'] as never })).toThrow(/five/i);
    expect(() => runVerticalSlice({ cohorts: ['only-one'] as never })).toThrow(/cohort/i);
    expect(() => runVerticalSlice({ road: { cost: 0, duration: 1 } })).toThrow(/road/i);
    expect(() => runVerticalSlice({ aiMinimumStock: -1 })).toThrow(/stock/i);
  });
});
