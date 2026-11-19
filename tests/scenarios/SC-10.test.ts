// SC-10 — three-nations fixture: trade-restriction policy by the importer blocks shipments of
// the restricted commodity on that route during the policy, other trade continues, trade
// resumes after expiry.
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';

interface Shipment {
  routeId: string;
  commodity: string;
  departureTick: number;
  status: string;
}

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

const clothesOf = (domain: Record<string, unknown>) =>
  ((domain.logistics as { shipments: Shipment[] }).shipments ?? []).filter(
    (s) => s.commodity === 'clothes' && s.routeId === 'coast-plain-road',
  );

describe('SC-10 importer trade-restriction on clothes via coast-plain-road', () => {
  it('blocks restricted shipments during the policy and lets other trade continue', () => {
    const restricted = drive(260, { tradeRestriction: true }).engine.getState().domain;
    const baseline = drive(260).engine.getState().domain;

    const restrictedClothes = clothesOf(restricted);
    // pre-policy departure (tick 103) and post-expiry resumption (tick 203/205) exist
    expect(restrictedClothes.some((s) => s.departureTick < 122)).toBe(true);
    expect(restrictedClothes.some((s) => s.departureTick > 200)).toBe(true);
    // nothing departs inside the policy window (effective 122, expiry 200)
    expect(
      restrictedClothes.filter((s) => s.departureTick >= 122 && s.departureTick <= 200),
    ).toHaveLength(0);
    // baseline ships through the same window — the restriction is the only difference
    expect(baselineClothesInWindow(baseline).length).toBeGreaterThan(0);
    // other trade on other routes continues
    const otherTrade = ((restricted.logistics as { shipments: Shipment[] }).shipments ?? []).filter(
      (s) => s.commodity !== 'clothes',
    );
    expect(otherTrade.length).toBeGreaterThan(0);
  }, 1800000);
});

function baselineClothesInWindow(domain: Record<string, unknown>) {
  return clothesOf(domain).filter((s) => s.departureTick >= 122 && s.departureTick <= 200);
}
