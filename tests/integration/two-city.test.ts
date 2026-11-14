import { describe, expect, it } from 'vitest';
import { runTwoCityScenario } from '@epcse/scenarios';
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
