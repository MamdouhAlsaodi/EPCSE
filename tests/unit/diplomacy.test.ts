import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerDiplomacy,
  registerLogistics,
} from '../../packages/simulation-core/src/index.js';

const setup = (stock: number) => {
  const engine = createEngine({ initialState: {} }, 1);
  registerDiplomacy(engine, {
    offers: [
      {
        offerId: 'grain-1',
        fromKingdomId: 'north',
        toKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
      },
    ],
    kingdoms: [
      { kingdomId: 'north', controller: 'player' },
      { kingdomId: 'south', controller: 'ai' },
    ],
    preferences: {
      north: { minimumTreasury: 0, minimumStock: 0 },
      south: { minimumTreasury: 0, minimumStock: 2 },
    },
  });
  registerLogistics(engine, {
    currency: { id: 'coin', unit: 'coin', scale: 0 },
    commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
    owners: ['north', 'south', 'carrier', 'transit'],
    accounts: [
      { id: 'north-cash', ownerId: 'north', openingBalance: 0 },
      { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
      { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
    ],
    stock: stock ? [{ ownerId: 'south', commodity: 'grain', quantity: stock }] : [],
    transitOwnerId: 'transit',
    cities: ['n-city', 's-city'],
    cityOwnerIds: { 'n-city': 'north', 's-city': 'south' },
    cityKingdomIds: { 'n-city': 'north', 's-city': 'south' },
    routes: [
      {
        routeId: 'road',
        sourceCityId: 'n-city',
        destinationCityId: 's-city',
        travelTicks: 1,
        capacity: 1,
        fare: 1,
        carrierAccountId: 'carrier-cash',
      },
    ],
  });
  return engine;
};

describe('bilateral trade decisions', () => {
  it('lets the AI decide from its own observable stock and records both choices', () => {
    const refused = setup(0);
    refused.step();
    const refusal = (
      refused.getState().domain.diplomacy as {
        decisions: Array<{
          kingdomId: string;
          accepted: boolean;
          alternatives: string[];
          information: string[];
        }>;
      }
    ).decisions[0]!;
    expect(refusal).toMatchObject({
      kingdomId: 'south',
      accepted: false,
      alternatives: ['accept', 'refuse'],
    });
    expect(refusal.information).toContain('available grain=0');
    const accepted = setup(2);
    accepted.step();
    expect(
      (accepted.getState().domain.diplomacy as { decisions: Array<{ accepted: boolean }> })
        .decisions[0]?.accepted,
    ).toBe(true);
  });
  it('rejects malformed configuration instead of accepting preloaded outcomes', () => {
    expect(() =>
      registerDiplomacy(createEngine({ initialState: {} }, 1), { offers: [] } as never),
    ).toThrow();
    expect(() =>
      registerDiplomacy(createEngine({ initialState: {} }, 1), {
        offers: [
          { offerId: 'o', fromKingdomId: 'n', toKingdomId: 's', routeId: 'r', commodity: 'g' },
        ],
        kingdoms: [
          { kingdomId: 'n', controller: 'player' },
          { kingdomId: 's', controller: 'player' },
        ],
        preferences: {
          n: { minimumTreasury: 0, minimumStock: 0 },
          s: { minimumTreasury: 0, minimumStock: 0 },
        },
      }),
    ).toThrow();
  });
});
