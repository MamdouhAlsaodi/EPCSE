// SC-01 — three-nations-trade-and-politics fixture: 180-tick baseline production, trade,
// pricing, consumption, and conservation invariants (no shock lever configured).
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';
import type { AccountingState } from '@epcse/simulation-core';
import { projectWorld } from '../../packages/analytics/src/index.js';
import { advanceResponsively } from './advance-responsively.js';

async function drive(ticks: number) {
  const fixture = createThreeNations({ ticks });
  const commands = [];
  for (let tick = 1; tick <= ticks; tick++) commands.push(...fixture.commandsForTick(tick));
  for (const command of commands) fixture.engine.submit(command);
  await advanceResponsively(fixture.engine, ticks);
  return fixture;
}

describe('SC-01 three-nations 180-tick baseline', () => {
  it('produces, trades, prices, consumes, conserves money, and stays nonnegative', async () => {
    const fixture = await drive(180);
    const domain = fixture.engine.getState().domain;
    const accounting = domain.accounting as AccountingState;
    const world = projectWorld(domain, 180);

    expect(world.world.produced).toBeGreaterThan(0);
    expect(world.world.departed).toBeGreaterThanOrEqual(1);
    expect(world.world.arrived).toBeGreaterThanOrEqual(1);
    expect(world.world.consumed).toBeGreaterThan(0);
    const quotes = Object.values(
      (domain.economy as { quotes: Record<string, { price: number }> }).quotes,
    );
    expect(quotes.length).toBeGreaterThan(0);
    for (const { price } of quotes) {
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(1);
      expect(price).toBeLessThanOrEqual(80); // configured seller max prices
    }
    expect(accounting.accounts.every((a) => a.balance >= 0)).toBe(true);
    expect(accounting.stock.every((s) => s.quantity >= 0)).toBe(true);
    const opening = accounting.openingBalances.reduce((sum, e) => sum + e.balance, 0);
    expect(accounting.accounts.reduce((sum, e) => sum + e.balance, 0)).toBe(opening);
    expect(world.world.treasury).toBeLessThanOrEqual(opening);
  }, 900000);
});
