import { describe, expect, it } from 'vitest';
import {
  createTwoCitySimulation,
  restoreTwoCitySimulation,
  runTwoCityScenario,
} from '@epcse/scenarios';
import { run } from '../../apps/cli/src/main.js';
import { engineStatus } from '@epcse/simulation-core';

describe('two-city demonstration', () => {
  it('prints the implemented demonstration rather than a bootstrap stub', () => {
    expect(run().join('\\n')).toMatch(/tick 100/i);
    expect(run().join('\\n')).toMatch(/shipment.*arrived/i);
    expect(run().join('\\n')).toMatch(/limited scripted demonstration/i);
    expect(run().join('\\n')).toMatch(/harbor.*7 traded.*7 consumed.*193 unmet/i);
    expect(run().join('\\n')).toMatch(/inland.*2 traded.*2 consumed.*98 unmet/i);
    expect(run().join('\\n')).toMatch(/producer stopped.*missing-inputs/i);
    expect(run().join('\\n')).toMatch(/not a complete S0/i);
    expect(engineStatus.implemented).toBe(false);
  });

  it('records and validates an explicit scenario-rules version', () => {
    const snapshot = createTwoCitySimulation().snapshot() as unknown as Record<string, unknown>;
    expect(snapshot.scenarioVersion).toBeDefined();
    snapshot.scenarioVersion = 'obsolete-rules';
    expect(() => restoreTwoCitySimulation(snapshot as never)).toThrow(/scenario.*version/i);
  });

  it('restores the valid initial snapshot before any ticks have run', () => {
    const original = createTwoCitySimulation();
    const resumed = restoreTwoCitySimulation(original.snapshot());
    original.run(4);
    resumed.run(4);
    expect(resumed.snapshot()).toEqual(original.snapshot());
  });

  it('rejects a checkpoint whose paused shipment implies a future route closure', () => {
    const simulation = createTwoCitySimulation();
    simulation.run(2);
    const snapshot = simulation.snapshot();
    (snapshot.routes as unknown as { closedRouteIds: string[] }).closedRouteIds = ['harbor-inland'];
    (
      snapshot.routes.shipments as unknown as {
        arrivalTick: number;
        pausedRemainingTicks: number;
      }[]
    )[0] = { ...snapshot.routes.shipments[0]!, arrivalTick: 100, pausedRemainingTicks: 2 };
    expect(() => restoreTwoCitySimulation(snapshot)).toThrow(/shipment/i);
  });

  it('resumes an in-transit snapshot with the same report as an uninterrupted run', () => {
    const uninterrupted = createTwoCitySimulation();
    uninterrupted.run(100);

    const paused = createTwoCitySimulation();
    paused.step();
    expect(paused.snapshot().routes.shipments[0]?.status).toBe('in-transit');
    const resumed = restoreTwoCitySimulation(paused.snapshot());
    resumed.run(99);

    expect(resumed.report()).toEqual(uninterrupted.report());
  });

  it('restores at the route arrival tick with an equivalent intermediate report', () => {
    const uninterrupted = createTwoCitySimulation();
    uninterrupted.run(3);

    const paused = createTwoCitySimulation();
    paused.run(3);
    expect(paused.snapshot().routes.shipments[0]?.status).toBe('arrived');
    const resumed = restoreTwoCitySimulation(paused.snapshot());
    expect(resumed.report()).toEqual(uninterrupted.report());
    resumed.run(97);
    uninterrupted.run(97);
    expect(resumed.snapshot()).toEqual(uninterrupted.snapshot());
    expect(resumed.report()).toEqual(uninterrupted.report());
  });

  it('resumes a snapshot after production stopped', () => {
    const uninterrupted = createTwoCitySimulation();
    uninterrupted.run(100);

    const paused = createTwoCitySimulation();
    paused.run(2);
    expect(paused.snapshot().producer.status).toBe('stopped');
    const resumed = restoreTwoCitySimulation(paused.snapshot());
    resumed.run(98);

    expect(resumed.report()).toEqual(uninterrupted.report());
  });

  it('rejects balanced money tampering that disagrees with recorded sales', () => {
    const simulation = createTwoCitySimulation();
    simulation.step();
    const snapshot = simulation.snapshot();
    const balances = snapshot.money.balances as { accountId: string; amount: number }[];
    balances.find((balance) => balance.accountId === 'harbor-households')!.amount -= 1;
    balances.find((balance) => balance.accountId === 'inland-households')!.amount += 1;
    expect(() => restoreTwoCitySimulation(snapshot)).toThrow(/money|account|balance/i);
  });

  it('rejects money balances and sales counters that are jointly tampered', () => {
    const simulation = createTwoCitySimulation();
    simulation.run(3);
    const snapshot = simulation.snapshot();
    (snapshot.counters as unknown as { harbor: { total: number } }).harbor.total += 1;
    const balances = snapshot.money.balances as { accountId: string; amount: number }[];
    balances.find((balance) => balance.accountId === 'harbor-households')!.amount -= 1;
    balances.find((balance) => balance.accountId === 'harbor-granary-account')!.amount += 1;
    expect(() => restoreTwoCitySimulation(snapshot)).toThrow(/sales|money|counter/i);
  });

  it('rejects owner-level inventory tampering and incorrect wood positions', () => {
    const ownershipSimulation = createTwoCitySimulation();
    ownershipSimulation.step();
    const ownership = ownershipSimulation.snapshot();
    const balances = ownership.inventory.balances as {
      ownerId: string;
      commodity: string;
      quantity: number;
    }[];
    balances.find((balance) => balance.ownerId === 'harbor-granary')!.ownerId = 'inland-workshop';
    expect(() => restoreTwoCitySimulation(ownership)).toThrow(/inventory|balance|producer/i);

    const woodSimulation = createTwoCitySimulation();
    woodSimulation.step();
    const wood = woodSimulation.snapshot();
    (wood.inventory.balances as { ownerId: string; commodity: string; quantity: number }[]).find(
      (balance) => balance.ownerId === 'inland-workshop' && balance.commodity === 'wood',
    )!.quantity = 3;
    expect(() => restoreTwoCitySimulation(wood)).toThrow(/inventory|wood|producer/i);
  });

  it('returns independent snapshot copies and rejects corrupt snapshots without changing simulation', () => {
    const simulation = createTwoCitySimulation();
    simulation.step();
    const before = simulation.snapshot();
    const external = simulation.snapshot();
    (external.inventory.balances as unknown as { quantity: number }[])[0]!.quantity = 999;
    expect(simulation.snapshot()).toEqual(before);

    const corrupt = simulation.snapshot();
    (corrupt.routes.shipments as unknown as { arrivalTick: number }[])[0]!.arrivalTick = -1;
    expect(() => restoreTwoCitySimulation(corrupt)).toThrow();
    const inconsistent = simulation.snapshot();
    (
      inconsistent.inventory.balances as unknown as {
        ownerId: string;
        commodity: string;
        quantity: number;
      }[]
    ).find((balance) => balance.ownerId === 'transit')!.quantity = 2;
    expect(() => restoreTwoCitySimulation(inconsistent)).toThrow(/transit/i);
    expect(simulation.snapshot()).toEqual(before);
  });

  it('executes and reports a deterministic 100-tick trade and delayed delivery', () => {
    const first = runTwoCityScenario();
    const second = runTwoCityScenario();

    expect(first).toEqual(second);
    expect(first.tick).toBe(100);
    expect(first.cities.map(({ id }) => id)).toEqual(['harbor', 'inland']);
    expect(first.goods).toEqual(['grain', 'wood', 'tools']);
    expect(first.production).toMatchObject({
      cityId: 'inland',
      commodity: 'tools',
      quantity: 2,
      batches: 1,
      status: 'stopped',
      stoppedReason: 'missing-inputs',
    });
    expect(first.recurring.harbor).toEqual({ demanded: 200, traded: 7, consumed: 7, unmet: 193 });
    expect(first.recurring.inland).toEqual({ demanded: 100, traded: 2, consumed: 2, unmet: 98 });
    expect(first.firstTickPrice).toEqual({
      commodity: 'grain',
      supplied: 7,
      demanded: 2,
      unitPrice: 1,
    });
    expect(first.trade).toMatchObject({ quantity: 7, total: 18, commodity: 'grain' });
    expect(first.trade.total).toBeGreaterThan(
      first.firstTickPrice.unitPrice * first.trade.quantity,
    );
    expect(first.trade.balancesAfter).toEqual({ buyer: 82, seller: 18 });
    expect(first.shipment).toMatchObject({ departureTick: 0, arrivalTick: 3, status: 'arrived' });
    expect(first.finalInventory).toContainEqual({
      ownerId: 'inland',
      commodity: 'grain',
      quantity: 3,
    });
    expect(first.finalInventory).toContainEqual({
      ownerId: 'inland-workshop',
      commodity: 'tools',
      quantity: 2,
    });
    expect(first.finalMoney).toEqual({
      buyerAccount: 82,
      sellerAccount: 18,
      inlandBuyerAccount: 56,
      inlandSellerAccount: 4,
    });
    expect(first.conservation.grainBefore).toBe(10);
    expect(first.conservation.grainConsumed).toBe(7);
    expect(first.conservation.grainAfter).toBe(3);
    expect(first.conservation.moneyBefore).toBe(160);
    expect(first.conservation.moneyAfter).toBe(160);
    expect(first.route).toMatchObject({ routeId: 'harbor-inland', travelTicks: 3 });
    expect(first.disclaimer).toMatch(/synthetic.*provisional/i);
    expect(first.disclaimer).toMatch(/not a complete S0/i);
  });
});
