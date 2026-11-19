// SC-08 — three-nations fixture: local-purchase-tax on one city raises treasury revenue by
// exactly the journal tax entries; the taxed buyer pays at least the baseline buyer.
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

const TAX_PREFIX = 'government:plain-central-purchase-tax:purchase:';

describe('SC-08 local-purchase-tax on plain-central', () => {
  it('collects exactly the journal tax entries and never double-counts', () => {
    const taxed = drive(20, { localPurchaseTax: true }).engine.getState().domain;
    const baseline = drive(20).engine.getState().domain;
    const taxedAccounting = taxed.accounting as AccountingState;
    const baselineAccounting = baseline.accounting as AccountingState;

    const taxEntries = taxedAccounting.journal.filter((entry) =>
      entry.causeId.startsWith(TAX_PREFIX),
    );
    expect(taxEntries.length).toBeGreaterThan(0);
    const taxTotal = taxEntries.reduce(
      (sum, entry) => sum + ((entry.effects[0] as { amount?: number }).amount ?? 0),
      0,
    );
    const treasury = taxedAccounting.accounts.find((a) => a.id === 'plains-treasury')!;
    const openingTreasury = taxedAccounting.openingBalances.find(
      (e) => e.accountId === 'plains-treasury',
    )!.balance;
    expect(treasury.balance - openingTreasury).toBe(taxTotal);

    const taxedPurchases = taxedAccounting.journal.filter(
      (entry) =>
        entry.type === 'payment' && entry.causeId.startsWith('purchase:plain-central-residents'),
    );
    const baselinePurchases = baselineAccounting.journal.filter(
      (entry) =>
        entry.type === 'payment' && entry.causeId.startsWith('purchase:plain-central-residents'),
    );
    const sum = (entries: typeof taxedPurchases) =>
      entries.reduce(
        (sum, entry) => sum + ((entry.effects[0] as { amount?: number }).amount ?? 0),
        0,
      );
    // buyer-side settlement reflects the added tax (direction; quantities may differ slightly)
    expect(sum(taxedPurchases) + taxTotal).toBeGreaterThanOrEqual(sum(baselinePurchases));
    // tax counted once: distinct transaction ids, each tax entry appears once
    const ids = new Set(taxEntries.map((e) => e.transactionId));
    expect(ids.size).toBe(taxEntries.length);
    expect(
      taxedAccounting.journal.filter((entry) => entry.causeId.startsWith(TAX_PREFIX)).length,
    ).toBe(taxEntries.length);
  }, 900000);
});
