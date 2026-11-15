import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerDiplomacy,
  registerLogistics,
  registerGovernment,
} from '../../packages/simulation-core/src/index.js';
const logistics = {
  currency: { id: 'coin', unit: 'coin', scale: 0 },
  commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
  owners: ['north', 'south', 'carrier', 'transit'],
  accounts: [
    { id: 'north-cash', ownerId: 'north', openingBalance: 10 },
    { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
    { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
  ],
  stock: [{ ownerId: 'north', commodity: 'grain', quantity: 3 }],
  transitOwnerId: 'transit',
  cities: ['north-city', 'south-city'],
  cityOwnerIds: { 'north-city': 'north', 'south-city': 'south' },
  cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
  routes: [
    {
      routeId: 'road',
      sourceCityId: 'north-city',
      destinationCityId: 'south-city',
      travelTicks: 1,
      capacity: 3,
      fare: 2,
      carrierAccountId: 'carrier-cash',
    },
  ],
};
const offer = {
  offerId: 'grain-road',
  fromKingdomId: 'north',
  toKingdomId: 'south',
  routeId: 'road',
  commodity: 'grain',
};
describe('government and bilateral policy integration', () => {
  const kingdoms = [
    {
      kingdomId: 'north',
      controller: 'player' as const,
      treasuryAccountId: 'north-cash',
      recipients: [{ kingdomId: 'north', ownerId: 'north', accountId: 'north-households' }],
    },
    {
      kingdomId: 'south',
      controller: 'ai' as const,
      treasuryAccountId: 'south-cash',
      recipients: [{ kingdomId: 'south', ownerId: 'south', accountId: 'south-cash' }],
    },
  ];
  const offerConfig = (southStock: number) => ({
    offers: [offer],
    kingdoms,
    preferences: {
      north: { minimumTreasury: 1, minimumStock: 1 },
      south: { minimumTreasury: 0, minimumStock: southStock },
    },
  });
  it('rejects cross-kingdom paid departure when diplomacy exists but kingdom mapping is absent', () => {
    const engine = createEngine({ initialState: {} }, 42);
    registerDiplomacy(engine, offerConfig(0));
    const { cityKingdomIds, ...unmappedLogistics } = logistics;
    void cityKingdomIds;
    registerLogistics(engine, unmappedLogistics);
    engine.step();
    engine.submit({
      commandId: 'unmapped-shipment',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'unmapped-shipment',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'north-cash',
        payment: 2,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unmapped-shipment')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.logistics).toMatchObject({ shipments: [] });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 10 },
        { id: 'carrier-cash', ownerId: 'carrier', balance: 0 },
      ]),
      stock: [expect.objectContaining({ ownerId: 'north', quantity: 3, location: 'available' })],
    });
  });
  it.each(['government-first', 'diplomacy-first'] as const)(
    'rejects inconsistent player roles when registered %s',
    (order) => {
      const engine = createEngine({ initialState: {} }, 42);
      const conflictingKingdoms = [
        { ...kingdoms[0]!, controller: 'ai' as const },
        { ...kingdoms[1]!, controller: 'player' as const },
      ];
      const governmentConfig = {
        kingdoms: conflictingKingdoms.map((k) => ({
          ...k,
          treasuryAccountId: k.kingdomId === 'north' ? 'north-cash' : 'south-cash',
          recipients: [
            { kingdomId: k.kingdomId, ownerId: k.kingdomId, accountId: `${k.kingdomId}-cash` },
          ],
        })),
      };
      if (order === 'government-first') {
        registerGovernment(engine, governmentConfig);
        registerDiplomacy(engine, offerConfig(0));
      } else {
        registerDiplomacy(engine, offerConfig(0));
        registerGovernment(engine, governmentConfig);
      }
      expect(() => engine.step()).toThrow();
    },
  );
  it('decides AI refusal and acceptance from its own treasury and stock before paid departure', () => {
    const engine = createEngine({ initialState: {} }, 42);
    registerDiplomacy(engine, offerConfig(2));
    registerLogistics(engine, logistics);
    const dispatch = (commandId: string) =>
      engine.submit({
        commandId,
        type: 'logistics.depart',
        requestedTick: 2,
        payload: {
          shipmentId: commandId,
          routeId: 'road',
          commodity: 'grain',
          quantity: 1,
          buyerAccountId: 'north-cash',
          payment: 2,
        },
      });
    engine.step();
    engine.submit({
      commandId: 'north-accept',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: {
        offerId: 'grain-road',
        kingdomId: 'north',
        accepted: true,
        reason: 'surplus stock',
      },
    });
    dispatch('refused');
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'refused')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([{ id: 'north-cash', ownerId: 'north', balance: 10 }]),
      stock: [expect.objectContaining({ ownerId: 'north', quantity: 3, location: 'available' })],
    });
    const decisions = (
      engine.getState().domain.diplomacy as {
        decisions: Array<{ accepted: boolean; kingdomId: string }>;
      }
    ).decisions;
    expect(decisions.find((d) => d.kingdomId === 'north')).toMatchObject({ accepted: true });
    expect(decisions.find((d) => d.kingdomId === 'south')).toMatchObject({ accepted: false });
    const accepted = createEngine({ initialState: {} }, 42);
    registerDiplomacy(accepted, offerConfig(0));
    registerLogistics(accepted, logistics);
    accepted.step();
    accepted.submit({
      commandId: 'north-accept',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: {
        offerId: 'grain-road',
        kingdomId: 'north',
        accepted: true,
        reason: 'surplus stock',
      },
    });
    accepted.submit({
      commandId: 'shipment',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'shipment',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'north-cash',
        payment: 2,
      },
    });
    accepted.step();
    expect(accepted.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit' }],
    });
    expect(accepted.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 8 },
        { id: 'carrier-cash', ownerId: 'carrier', balance: 2 },
      ]),
    });
    const restored = createEngine({ initialState: {} }, 42);
    registerDiplomacy(restored, offerConfig(0));
    registerLogistics(restored, logistics);
    restored.restore(accepted.snapshot());
    accepted.run(2);
    restored.run(2);
    expect(restored.snapshotText()).toBe(accepted.snapshotText());
  });
  it('schedules a player transfer and independently funds an AI policy from its own treasury', () => {
    const engine = createEngine({ initialState: {} }, 7);
    const governmentConfig = {
      kingdoms: [
        { ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] },
        {
          ...kingdoms[1]!,
          treasuryAccountId: 'south-extra',
          recipients: [
            ...kingdoms[1]!.recipients,
            { kingdomId: 'south', ownerId: 'south', accountId: 'south-households' },
          ],
          aiPolicy: {
            recipientOwnerId: 'south',
            recipientAccountId: 'south-households',
            amount: 2,
            reserve: 1,
          },
        },
      ],
    };
    const fundedLogistics = {
      ...logistics,
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-households', ownerId: 'south', openingBalance: 0 },
        { id: 'south-extra', ownerId: 'south', openingBalance: 5 },
      ],
    };
    registerGovernment(engine, governmentConfig);
    engine.submit({
      commandId: 'grant',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'grant',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north',
        recipientAccountId: 'north-households',
        amount: 3,
        effectiveTick: 2,
        expiryTick: 4,
      },
    });
    registerLogistics(engine, fundedLogistics);
    engine.step();
    expect(
      (
        engine.getState().domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts.find((a) => a.id === 'south-cash')?.balance,
    ).toBe(0);
    expect(
      (
        engine.getState().domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts.find((a) => a.id === 'south-households')?.balance,
    ).toBe(2);
    expect(engine.getState().domain.government).toMatchObject({
      decisions: [
        expect.objectContaining({
          kingdomId: 'south',
          selected: 'fund',
          alternatives: ['fund', 'retain'],
        }),
      ],
    });
    engine.step();
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 7 },
        { id: 'north-households', ownerId: 'north', balance: 3 },
        { id: 'south-cash', ownerId: 'south', balance: 0 },
      ]),
      journal: expect.arrayContaining([
        expect.objectContaining({ causeId: 'government:grant', type: 'payment' }),
      ]),
    });
    const before = engine.snapshotText();
    expect(
      engine.submit({
        commandId: 'ai-takeover',
        type: 'government.policy',
        requestedTick: 3,
        payload: {
          kingdomId: 'south',
          governmentId: 'south',
          policyId: 'bad',
          recipientKingdomId: 'south',
          recipientOwnerId: 'south',
          recipientAccountId: 'south-households',
          amount: 1,
          effectiveTick: 3,
          expiryTick: 4,
        },
      }),
    ).toMatchObject({ status: 'queued' });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'ai-takeover')?.status).toBe('rejected');
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 7 },
        { id: 'north-households', ownerId: 'north', balance: 3 },
      ]),
    });
    expect(before).not.toBe(engine.snapshotText());
  });
});
