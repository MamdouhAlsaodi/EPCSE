import { describe, expect, it } from 'vitest';
import { runMultiCityRerouteDemo } from '../../packages/scenarios/src/multicity-reroute.js';
import { run } from '../../apps/cli/src/main.js';

describe('three-city paid reroute demonstration', () => {
  it('reroutes a paid blocked shipment after waiting and reports conserved delivery evidence', () => {
    const report = runMultiCityRerouteDemo();

    expect(report).toMatchObject({
      cities: ['north', 'south', 'east'],
      routes: ['north-south-road', 'north-east-river'],
      shipment: {
        shipmentId: 'grain-reroute-demo',
        routeId: 'north-east-river',
        status: 'arrived',
        departureTick: 0,
        arrivalTick: 8,
        choiceTick: 3,
        originalDestinationCityId: 'south',
        deliveredCityId: 'east',
      },
      payments: { initial: 10, extra: 7, total: 17 },
      balances: { buyer: 83, carrier: 17 },
      destinationInventory: { south: 0, east: 2 },
      observations: {
        waiting: {
          tick: 3,
          status: 'in-transit',
          routeId: 'north-south-road',
          cargoInTransit: 2,
          east: 0,
          south: 0,
          extraPayment: 0,
        },
        beforeArrival: {
          tick: 7,
          status: 'in-transit',
          cargoInTransit: 2,
          east: 0,
          south: 0,
        },
      },
    });
    expect(report).toEqual(runMultiCityRerouteDemo());
    expect(report.conservation).toEqual({
      moneyBefore: 100,
      moneyAfter: 100,
      cargoBefore: 5,
      cargoAfter: 5,
    });
  });

  it('prints reroute evidence only when the opt-in CLI flag is supplied', () => {
    expect(run()).toEqual(run([]));
    const output = run(['--reroute-demo']).join('\n');
    expect(output).toContain('Three-city paid-reroute demonstration');
    expect(output).toContain('not a complete S0');
    expect(output).toContain('north-east-river');
  });
});
