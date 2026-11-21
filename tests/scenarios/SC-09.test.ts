// SC-09 — three-nations fixture: an accepted tariff-discount offer (tariffDiscountBps) makes the
// covered route+commodity import cost strictly lower than the tariff-only baseline; a
// non-covered commodity on the same route is unchanged.
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';
import type { AccountingState } from '@epcse/simulation-core';
import { advanceResponsively } from './advance-responsively.js';

async function drive(
  ticks: number,
  variant?: NonNullable<Parameters<typeof createThreeNations>[0]>['variant'],
) {
  const fixture = createThreeNations({ ticks, variant });
  const commands = [];
  for (let tick = 1; tick <= ticks; tick++) commands.push(...fixture.commandsForTick(tick));
  for (const command of commands) fixture.engine.submit(command);
  await advanceResponsively(fixture.engine, ticks);
  return fixture;
}

const tariffFor = (accounting: AccountingState, policyId: string, commodity: string) =>
  accounting.journal
    .filter((entry) => entry.causeId.startsWith(`government:${policyId}:shipment:`))
    .filter((entry) => entry.causeId.includes(`-${commodity}-`))
    .map((entry) => (entry.effects[0] as { amount?: number }).amount ?? 0);

describe('SC-09 tariff-discount offer on the covered pair', () => {
  it('lowers the covered tariff and leaves the non-covered commodity untouched', async () => {
    const discounted = (await drive(260, { tariffDiscount: true })).engine.getState().domain;
    const baseline = (await drive(260, { tariffOnly: true })).engine.getState().domain;
    const discountedAmounts = tariffFor(
      discounted.accounting as AccountingState,
      'clothes-import-tariff',
      'clothes',
    );
    const baselineAmounts = tariffFor(
      baseline.accounting as AccountingState,
      'clothes-import-tariff',
      'clothes',
    );
    expect(discountedAmounts.length).toBeGreaterThan(0);
    expect(baselineAmounts.length).toBeGreaterThan(0);
    for (const amount of discountedAmounts) expect(amount).toBe(8); // 10 * (10000-2000)/10000
    for (const amount of baselineAmounts) expect(amount).toBe(10);
    expect(Math.min(...discountedAmounts)).toBeLessThan(Math.min(...baselineAmounts));
    // non-covered commodity (cloth) pays no tariff in either run
    expect(
      tariffFor(discounted.accounting as AccountingState, 'clothes-import-tariff', 'cloth'),
    ).toHaveLength(0);
    expect(
      tariffFor(baseline.accounting as AccountingState, 'clothes-import-tariff', 'cloth'),
    ).toHaveLength(0);
  }, 1800000);
});
