import { describe, expect, it } from 'vitest';
import { runInitialTwoCities } from '../../packages/scenarios/src/initial-two-cities.js';
import { run } from '../../apps/cli/src/main.js';

describe('S0 real engine integration', () => {
  it('runs 100 engine ticks with paid production, delayed trade, and consumption', () => {
    const simulation = runInitialTwoCities(42, 100);
    const report = simulation.report();

    expect(report).toMatchObject({
      ticks: 100,
      cities: ['grain-coast', 'tool-inland'],
      goods: ['grain', 'wood', 'tools'],
    });
    expect(report.production.grain).toBeGreaterThan(0);
    expect(report.production.tools).toBeGreaterThan(0);
    expect(report.trade.departed).toBeGreaterThan(0);
    expect(report.trade.arrived).toBeGreaterThan(0);
    expect(report.trade.firstArrivalTick).toBeGreaterThan(report.trade.firstDepartureTick);
    expect(report.trade.woodQuantity).toBe(report.trade.arrived);
    expect(report.trade.unitPrice).toBe(3);
    expect(report.trade.paidTotal).toBe(report.trade.woodQuantity * report.trade.unitPrice);
    expect(report.trade.paymentCount).toBe(report.trade.arrived);
    expect(report.effects).toEqual(
      expect.arrayContaining(['conversion', 'payment', 'arrive', 'consume']),
    );
    expect(report.causes.some((cause: string) => cause.startsWith('wage:'))).toBe(true);
    expect(report.causes.some((cause: string) => cause.startsWith('purchase:'))).toBe(true);
    expect(report.causes.some((cause: string) => cause.endsWith(':fare'))).toBe(true);
    expect(report.payments.trade).toBe(report.trade.arrived);
    expect(report.payments.wages).toBeGreaterThan(0);
    expect(report.payments.localPurchases).toBeGreaterThan(0);
    expect(report.payments.freight).toBeGreaterThan(0);
    expect(report.paymentJournalEntries).toBe(
      report.payments.trade +
        report.payments.wages +
        report.payments.localPurchases +
        report.payments.freight,
    );
    expect(report.trade.arrivalsPaidAfterDelivery).toBe(true);
    expect(report.trade.paymentPartiesValid).toBe(true);
    expect(new Set(report.prices).size).toBeGreaterThan(1);
    expect(report.money.total).toBe(report.money.openingTotal);
    expect(report.stock.nonnegative).toBe(true);
    expect(report.money.nonnegative).toBe(true);
    expect(report.hashes.state).toMatch(/^[a-f0-9]{64}$/);
    expect(report.hashes.events).toMatch(/^[a-f0-9]{64}$/);
    expect(report.shipments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'arrived',
          inTransitImmediatelyBeforeArrival: true,
          destinationEmptyImmediatelyBeforeArrival: true,
          deliveredWood: 1,
          paidWood: 1,
        }),
      ]),
    );
  }, 30000);

  it('repeats identical state and event hashes for the same seed and commands', () => {
    const first = runInitialTwoCities(42, 100).report();
    const second = runInitialTwoCities(42, 100).report();
    expect(second.hashes).toEqual(first.hashes);
  }, 60000);

  it('exposes a deterministic run entrypoint and rejects invalid CLI options', () => {
    expect(
      run(['run', '--scenario', 'initial-two-cities', '--seed', '42', '--ticks', '1']),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('State hash:'),
        expect.stringContaining('Event hash:'),
      ]),
    );
    expect(() => run(['run', '--scenario', 'unknown'])).toThrow(/scenario/);
    expect(() => run(['run', '--scenario', 'initial-two-cities', '--ticks', '0'])).toThrow(
      /positive/,
    );
    expect(() => run(['run', '--scenario', 'initial-two-cities', '--seed', '4294967296'])).toThrow(
      /uint32/,
    );
  });

  it('rejects invalid seeds and tick counts', () => {
    expect(() => runInitialTwoCities(-1, 100)).toThrow();
    expect(() => runInitialTwoCities(1, 0)).toThrow();
  });
});
