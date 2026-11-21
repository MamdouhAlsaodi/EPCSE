// SC-13 — three-nations fixture variant: a low-cash firm with unavoidable wage obligations goes
// insolvent under the engine's own two-tick liquidity rule; a control firm keeps producing.
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

interface FirmsView {
  firms: Record<string, { status: string; employment: number; closureReason: string | null }>;
}

describe('SC-13 firm insolvency via the engine liquidity rule', () => {
  it('insolvencies the underfunded producer and keeps a control firm producing', () => {
    const domain = drive(12, { insolventProducer: true }).engine.getState().domain;
    const firms = (domain.firms as FirmsView).firms;
    expect(firms['coast-alchemist']?.status).toBe('insolvent');
    expect(firms['coast-alchemist']?.employment).toBe(0);
    expect(firms['coast-alchemist']?.closureReason).toBe('repeated-wage-liquidity-failure');
    expect(firms['mountain-mine']?.status).toBe('active');
    const economy = domain.economy as {
      producers: Record<string, { stopped: string | null; batches: number }>;
    };
    expect(economy.producers['coast-alchemist']?.stopped).toBe('closed');
    expect(economy.producers['mountain-mine']?.batches).toBeGreaterThan(0);
    const accounting = domain.accounting as AccountingState;
    expect(accounting.accounts.every((a) => a.balance >= 0)).toBe(true);
    expect(accounting.stock.every((s) => s.quantity >= 0)).toBe(true);
    // NOTE: the fixture's alchemist exists only under the insolventProducer lever (openingCash 1),
    // so no funded same-firm control run is constructible without tuning the fixture; the healthy
    // mountain-mine firm in the same run is the honest control (asserted above).
  }, 900000);
});
