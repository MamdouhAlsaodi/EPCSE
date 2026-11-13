import { describe, expect, it } from 'vitest';
import { runTwoCityScenario } from '@epcse/scenarios';
import { run } from '../../apps/cli/src/main.js';

describe('two-city demonstration', () => {
  it('prints the implemented demonstration rather than a bootstrap stub', () => {
    expect(run().join('\\n')).toMatch(/tick 100/i);
    expect(run().join('\\n')).toMatch(/shipment.*arrived/i);
    expect(run().join('\\n')).toMatch(/limited scripted demonstration/i);
  });

  it('executes and reports a deterministic 100-tick trade and delayed delivery', () => {
    const first = runTwoCityScenario();
    const second = runTwoCityScenario();

    expect(first).toEqual(second);
    expect(first.tick).toBe(100);
    expect(first.cities.map(({ id }) => id)).toEqual(['harbor', 'inland']);
    expect(first.goods).toEqual(['grain', 'wood', 'tools']);
    expect(first.production).toMatchObject({ cityId: 'inland', commodity: 'tools', quantity: 4 });
    expect(first.trade).toMatchObject({ quantity: 3, total: 12, commodity: 'grain' });
    expect(first.trade.balancesAfter).toEqual({ buyer: 88, seller: 12 });
    expect(first.shipment).toMatchObject({ departureTick: 0, arrivalTick: 3, status: 'arrived' });
    expect(first.finalInventory).toContainEqual({
      ownerId: 'inland',
      commodity: 'grain',
      quantity: 3,
    });
    expect(first.finalInventory).toContainEqual({
      ownerId: 'inland-workshop',
      commodity: 'tools',
      quantity: 4,
    });
    expect(first.finalMoney).toEqual({ buyerAccount: 88, sellerAccount: 12 });
    expect(first.disclaimer).toMatch(/provisional/i);
  });
});
