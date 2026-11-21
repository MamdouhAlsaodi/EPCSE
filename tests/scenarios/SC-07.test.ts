// SC-07 — three-nations fixture: government.policy food-subsidy variant debits the treasury
// exactly per settlement journal refunds and credits the recipient; money is conserved.
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';
import type { AccountingState } from '@epcse/simulation-core';

function drive(
  ticks: number,
  variant?: NonNullable<Parameters<typeof createThreeNations>[0]>['variant'],
) {
  const fixture = createThreeNations({ ticks, variant });
  const commands = [];
  for (let tick = 1; tick <= ticks; tick++) commands.push(...fixture.commandsForTick(tick));
  for (const command of commands) fixture.engine.submit(command);
  fixture.engine.run(ticks);
  return fixture;
}

const refundEntries = (accounting: AccountingState) =>
  accounting.journal.filter((entry) =>
    entry.causeId.startsWith('government:plain-bread-subsidy:purchase:'),
  );
const entryAmount = (entry: { effects: readonly unknown[] }) =>
  (entry.effects[0] as { amount?: number }).amount ?? 0;

describe('SC-07 food-subsidy policy on the fixture', () => {
  it('refunds actual staple purchases from the treasury exactly, conserving money', () => {
    const subsidized = drive(20, { foodSubsidy: true }).engine.getState().domain;
    const accounting = subsidized.accounting as AccountingState;
    const refunds = refundEntries(accounting);
    expect(refunds.length).toBeGreaterThan(0);
    const totalRefund = refunds.reduce((sum, entry) => sum + entryAmount(entry), 0);
    const treasury = accounting.accounts.find((a) => a.id === 'plains-treasury');
    const recipient = accounting.accounts.find((a) => a.id === 'plain-central-residents-cash');
    const openingTreasury = accounting.openingBalances.find(
      (e) => e.accountId === 'plains-treasury',
    )!.balance;
    const serviceEntries = accounting.journal.filter(
      (entry) => entry.causeId === 'city-service:plain-central',
    );
    expect(serviceEntries).toHaveLength(20);
    for (const entry of serviceEntries) {
      expect(entry.effects).toContainEqual({
        debit: 'plain-central-residents-cash',
        credit: 'plains-treasury',
        amount: 1,
        stockDeltas: [],
      });
    }
    const serviceRevenue = serviceEntries.length;
    expect(openingTreasury - treasury!.balance).toBe(totalRefund - serviceRevenue);
    expect(recipient!.balance).toBeGreaterThan(0);
    const opening = accounting.openingBalances.reduce((sum, e) => sum + e.balance, 0);
    expect(accounting.accounts.reduce((sum, e) => sum + e.balance, 0)).toBe(opening);

    const baseline = drive(20).engine.getState().domain;
    expect(refundEntries(baseline.accounting as AccountingState)).toHaveLength(0);
  }, 900000);
});
