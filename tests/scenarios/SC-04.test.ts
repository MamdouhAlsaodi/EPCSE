// SC-04 — three-nations fixture: route-close shock pauses in-transit shipments on the closed
// route (resume after reopen) while the alternative plains↔mountains route keeps carrying.
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';

interface Shipment {
  routeId: string;
  status: string;
  arrivalTick: number;
  departureTick: number;
  pausedRemainingTicks?: number;
}

describe('SC-04 route-close shock with in-transit pause and alternative route', () => {
  it('pauses the in-transit food shipment during closure and lets the alternative route carry', () => {
    const fixture = createThreeNations({
      ticks: 150,
      shock: {
        kind: 'route-close',
        routeId: 'plains-mountains-road',
        durationTicks: 20,
        startTick: 121,
      },
    });
    const schedule = [];
    for (let tick = 1; tick <= 150; tick++) schedule.push(...fixture.commandsForTick(tick));
    for (const command of schedule) fixture.engine.submit(command);
    fixture.engine.run(121);
    const atClosure = fixture.engine.getState().domain;
    const main = (atClosure.logistics as { shipments: Shipment[] }).shipments.filter(
      (s) => s.routeId === 'plains-mountains-road',
    );
    // the tick-103 departure is in transit when the route closes at 121
    expect(
      main.some((s) => s.status === 'in-transit' && s.pausedRemainingTicks !== undefined),
    ).toBe(true);
    const alt = (atClosure.logistics as { shipments: Shipment[] }).shipments.filter(
      (s) => s.routeId === 'plains-mountains-pass',
    );
    expect(alt.some((s) => s.status === 'in-transit' && s.pausedRemainingTicks === undefined)).toBe(
      true,
    );

    fixture.engine.run(19); // through the closure window (121..140), still closed at 140
    const inClosure = fixture.engine.getState().domain;
    const closedRoutes = (inClosure.logistics as { closedRouteIds: string[] }).closedRouteIds;
    expect(closedRoutes).toContain('plains-mountains-road');
    expect(
      (inClosure.logistics as { shipments: Shipment[] }).shipments.filter(
        (s) =>
          s.routeId === 'plains-mountains-road' && s.departureTick > 121 && s.departureTick <= 141,
      ),
    ).toHaveLength(0);

    fixture.engine.step(); // tick 142: reopen happened at tick 141
    const reopened = fixture.engine.getState().domain;
    const resumed = (reopened.logistics as { shipments: Shipment[] }).shipments.filter(
      (s) => s.routeId === 'plains-mountains-road',
    );
    expect(
      resumed.some((s) => s.status === 'in-transit' && s.pausedRemainingTicks === undefined),
    ).toBe(true);
    expect((reopened.logistics as { closedRouteIds: string[] }).closedRouteIds).not.toContain(
      'plains-mountains-road',
    );
  }, 900000);
});
