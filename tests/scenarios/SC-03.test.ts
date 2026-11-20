// SC-03 — three-nations fixture: a viable accepted trade route departs, arrives, pays freight
// (journal causeId, carrier credited); the refused-player-decision control ships nothing.
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

interface Shipment {
  routeId: string;
  status: string;
}
const routeShipments = (domain: Record<string, unknown>, routeId: string): Shipment[] =>
  ((domain.logistics as { shipments: Shipment[] }).shipments ?? []).filter(
    (s) => s.routeId === routeId,
  );

describe('SC-03 viable accepted trade route vs refused control', () => {
  it('moves a shipment with paid freight when plains accepts, and ships nothing when it refuses', async () => {
    const accepted = (await drive(40)).engine.getState().domain;
    const shipments = routeShipments(accepted, 'plains-mountains-road');
    expect(shipments.length).toBeGreaterThanOrEqual(1);
    expect(shipments.some((s) => s.status === 'arrived')).toBe(true);
    const accounting = accepted.accounting as AccountingState;
    const fare = accounting.journal.find(
      (entry) =>
        entry.causeId.startsWith('logistics:ship-plains-mountains-road-grain-') &&
        entry.causeId.endsWith(':fare'),
    );
    expect(fare).toBeDefined();
    const effect = fare!.effects[0] as { debit: string; credit: string; amount: number };
    expect(effect.credit).toBe('carrier-cash');
    expect(effect.amount).toBe(3);

    const refused = (await drive(40, { playerDecision: 'refuse' })).engine.getState().domain;
    expect(routeShipments(refused, 'plains-mountains-road')).toHaveLength(0);
    const refusedAccounting = refused.accounting as AccountingState;
    expect(
      refusedAccounting.journal.filter(
        (entry) =>
          entry.causeId.includes('plains-mountains-road') && entry.causeId.includes(':fare'),
      ).length,
    ).toBe(0);
  }, 900000);
});
