import { describe, expect, it } from 'vitest';
import {
  createEngine,
  hasBilateralTradePermit,
  registerDiplomacy,
  registerLogistics,
} from '../../packages/simulation-core/src/index.js';

const setup = (stock: number, relation?: { trust: number; interests: Record<string, number> }) => {
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
    ...(relation ? { relations: [{ kingdomA: 'north', kingdomB: 'south', ...relation }] } : {}),
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
      {
        routeId: 'return-road',
        sourceCityId: 's-city',
        destinationCityId: 'n-city',
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
  it('keeps accepted treaty terms inactive before their bounded effect window', () => {
    const engine = createEngine({ initialState: {} }, 1);
    expect(() =>
      registerDiplomacy(engine, {
        offers: [
          {
            offerId: 'windowed',
            fromKingdomId: 'north',
            toKingdomId: 'south',
            routeId: 'road',
            commodity: 'grain',
            effectiveTick: 3,
            expiryTick: 5,
            quota: -1,
            tariffDiscountBps: 2500,
          },
        ],
        kingdoms: [
          { kingdomId: 'north', controller: 'player' },
          { kingdomId: 'south', controller: 'ai' },
        ],
        preferences: {
          north: { minimumTreasury: 0, minimumStock: 0 },
          south: { minimumTreasury: 0, minimumStock: 0 },
        },
      }),
    ).toThrow();
    registerDiplomacy(engine, {
      offers: [
        {
          offerId: 'windowed',
          fromKingdomId: 'north',
          toKingdomId: 'south',
          routeId: 'road',
          commodity: 'grain',
          effectiveTick: 3,
          expiryTick: 5,
          quota: 2,
          tariffDiscountBps: 2500,
        },
      ],
      kingdoms: [
        { kingdomId: 'north', controller: 'player' },
        { kingdomId: 'south', controller: 'ai' },
      ],
      preferences: {
        north: { minimumTreasury: 0, minimumStock: 0 },
        south: { minimumTreasury: 0, minimumStock: 0 },
      },
    });
    registerLogistics(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'carrier', 'transit'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 1 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 1 },
        { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'south', commodity: 'grain', quantity: 1 }],
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
    engine.step();
    engine.submit({
      commandId: 'accept',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: { offerId: 'windowed', kingdomId: 'north', accepted: true, reason: 'beneficial' },
    });
    engine.step();
    const domain = engine.getState().domain;
    expect(hasBilateralTradePermit(domain, 'road', 'grain', 'north', 'south', 2)).toBe(false);
    expect(hasBilateralTradePermit(domain, 'road', 'grain', 'north', 'south', 3)).toBe(true);
    expect(hasBilateralTradePermit(domain, 'road', 'grain', 'north', 'south', 6)).toBe(false);
  });

  it('registers trust and independent interests and records auditable bilateral decisions', () => {
    const engine = setup(2);
    engine.step();
    const relation = (
      engine.getState().domain.diplomacy as {
        relations?: Array<{
          a: string;
          b: string;
          trust: number;
          interests: Record<string, number>;
        }>;
      }
    ).relations?.[0];
    expect(relation).toMatchObject({
      a: 'north',
      b: 'south',
      trust: 51,
      interests: { trade: 50 },
    });
    engine.submit({
      commandId: 'explicit-refusal',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: {
        offerId: 'grain-1',
        kingdomId: 'north',
        accepted: false,
        reason: 'unfavorable terms',
      },
    });
    engine.step();
    expect(
      (
        engine.getState().domain.diplomacy as {
          decisions: Array<{ kingdomId: string; accepted: boolean; reason: string }>;
        }
      ).decisions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kingdomId: 'north',
          accepted: false,
          reason: 'unfavorable terms',
        }),
      ]),
    );
  });

  it('records a player-issued targeted sanction with a bounded route and commodity window', () => {
    const engine = setup(2);
    engine.step();
    engine.submit({
      commandId: 'sanction',
      type: 'diplomacy.sanction',
      requestedTick: 2,
      payload: {
        sanctionId: 'north-south-grain',
        issuerKingdomId: 'north',
        targetKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        effectiveTick: 3,
        expiryTick: 5,
        reason: 'retaliation for breach',
      },
    });
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'sanction')).toMatchObject({
      status: 'applied',
    });
    expect(engine.getState().domain.diplomacy).toMatchObject({
      sanctions: [
        {
          sanctionId: 'north-south-grain',
          issuerKingdomId: 'north',
          targetKingdomId: 'south',
          routeId: 'road',
          commodity: 'grain',
          effectiveTick: 3,
          expiryTick: 5,
        },
      ],
    });
  });

  it('rejects duplicate bilateral relation configurations regardless of pair order', () => {
    expect(() =>
      registerDiplomacy(createEngine({ initialState: {} }, 1), {
        offers: [
          { offerId: 'o', fromKingdomId: 'n', toKingdomId: 's', routeId: 'r', commodity: 'g' },
        ],
        kingdoms: [
          { kingdomId: 'n', controller: 'player' },
          { kingdomId: 's', controller: 'ai' },
        ],
        preferences: {
          n: { minimumTreasury: 0, minimumStock: 0 },
          s: { minimumTreasury: 0, minimumStock: 0 },
        },
        relations: [
          { kingdomA: 'n', kingdomB: 's', trust: 40, interests: { trade: 60 } },
          { kingdomA: 's', kingdomB: 'n', trust: 50, interests: { trade: 50 } },
        ],
      }),
    ).toThrow('invalid diplomacy configuration');
  });

  it('rejects an invalid treaty withdrawal penalty during configuration', () => {
    expect(() =>
      registerDiplomacy(createEngine({ initialState: {} }, 1), {
        offers: [
          {
            offerId: 'bad-penalty',
            fromKingdomId: 'north',
            toKingdomId: 'south',
            routeId: 'road',
            commodity: 'grain',
            withdrawalPenalty: -1,
          },
        ],
        kingdoms: [
          { kingdomId: 'north', controller: 'player' },
          { kingdomId: 'south', controller: 'ai' },
        ],
        preferences: {
          north: { minimumTreasury: 0, minimumStock: 0 },
          south: { minimumTreasury: 0, minimumStock: 0 },
        },
      }),
    ).toThrow('invalid diplomacy configuration');
  });

  it('scores AI treaty choices with bilateral trust and commodity interest', () => {
    const lowTrust = setup(2, { trust: 0, interests: { grain: 0 } });
    lowTrust.step();
    expect(
      (lowTrust.getState().domain.diplomacy as { decisions: Array<{ accepted: boolean }> })
        .decisions[0]?.accepted,
    ).toBe(false);
    const highUtility = setup(0, { trust: 100, interests: { grain: 100 } });
    highUtility.step();
    expect(
      (highUtility.getState().domain.diplomacy as { decisions: Array<{ accepted: boolean }> })
        .decisions[0]?.accepted,
    ).toBe(true);
  });

  it('records deterministic independent sanction response or abstention', () => {
    const makeVictim = (trust: number, interest: number) => {
      const engine = setup(0, { trust, interests: { grain: interest } });
      engine.step();
      engine.submit({
        commandId: 'player-sanction',
        type: 'diplomacy.sanction',
        requestedTick: 2,
        payload: {
          sanctionId: 'player-sanction',
          issuerKingdomId: 'north',
          targetKingdomId: 'south',
          routeId: 'road',
          commodity: 'grain',
          effectiveTick: 2,
          expiryTick: 4,
          reason: 'policy',
        },
      });
      engine.step();
      return engine.getState().domain.diplomacy as {
        sanctions: Array<{
          sanctionId: string;
          issuerKingdomId: string;
          targetKingdomId: string;
          routeId: string;
        }>;
        sanctionDecisions: Array<{
          decisionId: string;
          choice: string;
          alternatives: string[];
          information: string[];
          scores: Record<string, number>;
          reason: string;
        }>;
      };
    };
    const retaliation = makeVictim(0, 100);
    expect(retaliation.sanctionDecisions).toMatchObject([
      {
        decisionId: 'diplomacy:response:player-sanction:south',
        choice: 'respond',
        alternatives: ['respond', 'abstain'],
      },
    ]);
    expect(retaliation.sanctions).toHaveLength(2);
    expect(retaliation.sanctions[1]).toMatchObject({
      issuerKingdomId: 'south',
      targetKingdomId: 'north',
      routeId: 'return-road',
    });
    const abstention = makeVictim(100, 0);
    expect(abstention.sanctionDecisions).toMatchObject([
      {
        decisionId: 'diplomacy:response:player-sanction:south',
        choice: 'abstain',
        alternatives: ['respond', 'abstain'],
      },
    ]);
    expect(abstention.sanctions).toHaveLength(1);
    expect(makeVictim(0, 100)).toEqual(retaliation);
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
