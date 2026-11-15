import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runInitialTwoCities } from '../../packages/scenarios/src/initial-two-cities.js';
import { run } from '../../apps/cli/src/main.js';

// Long synchronous 100-tick runs starve Vitest's worker RPC on shared CI runners.
// Typecheck builds this same scenario before the test step; keep its assertions
// while running the engine in an asynchronous child process.
async function reportAfter100Ticks(): Promise<
  ReturnType<ReturnType<typeof runInitialTwoCities>['report']>
> {
  const script =
    "import { runInitialTwoCities } from './packages/scenarios/dist/initial-two-cities.js'; console.log(JSON.stringify(runInitialTwoCities(42, 100).report()))";
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as ReturnType<ReturnType<typeof runInitialTwoCities>['report']>;
}

describe('S0 real engine integration', () => {
  it('runs 100 engine ticks with paid production, delayed trade, and consumption', async () => {
    const report = await reportAfter100Ticks();

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
  }, 180000);

  it('repeats identical state and event hashes for the same seed and commands', async () => {
    const [first, second] = await Promise.all([reportAfter100Ticks(), reportAfter100Ticks()]);
    expect(second.hashes).toEqual(first.hashes);
  }, 180000);

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
