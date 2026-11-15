import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerDiplomacy,
  registerLogistics,
  registerGovernment,
  registerLocalEconomy,
  registerCities,
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
  it('rejects foreign import-policy commands without changing policy state', () => {
    const engine = createEngine({ initialState: {} }, 110);
    registerLogistics(engine, {
      ...logistics,
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
    });
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
    });
    engine.step();
    engine.submit({
      commandId: 'foreign-import-policy',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'import-tariff',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'foreign-policy',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        amount: 2,
        effectiveTick: 2,
        expiryTick: 3,
      },
    });
    engine.submit({
      commandId: 'foreign-trade-restriction',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'trade-restriction',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'foreign-restriction',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        effectiveTick: 2,
        expiryTick: 3,
      },
    });
    engine.step();
    for (const commandId of ['foreign-import-policy', 'foreign-trade-restriction']) {
      expect(engine.receipts().find((receipt) => receipt.commandId === commandId)?.status).toBe(
        'rejected',
      );
    }
    const government = engine.getState().domain.government as { tradePolicies: unknown[] };
    expect(government.tradePolicies).toEqual([]);
  });

  it('rejects restored government snapshots with tampered city jurisdiction mappings', () => {
    const engine = createEngine({ initialState: {} }, 109);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
    });
    engine.step();
    const snapshot = engine.snapshot();
    const domain = snapshot.domain as {
      government: { cityKingdomIds: Record<string, string> };
    };
    domain.government.cityKingdomIds['north-city'] = 'south';
    const restored = createEngine({ initialState: {} }, 109);
    registerGovernment(restored, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
    });
    expect(() => restored.restore(snapshot)).toThrow(/invalid government state/);
  });

  it('funds a bounded city service investment and applies it once until expiry', () => {
    const engine = createEngine({ initialState: {} }, 111);
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'contractor', 'households', 'farm'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 20 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'contractor-cash', ownerId: 'contractor', openingBalance: 0 },
        { id: 'house-cash', ownerId: 'households', openingBalance: 0 },
        { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
        { id: 'carrier-cash', ownerId: 'farm', openingBalance: 0 },
        { id: 'migration-fund', ownerId: 'households', openingBalance: 0 },
      ],
      cohorts: [],
      producers: [],
      sellers: [],
      stock: [],
    });
    registerCities(engine, {
      cities: [
        {
          id: 'north-city',
          serviceCapacity: { care: 2 },
          serviceProvisionCost: 0,
          serviceAccountId: 'house-cash',
          serviceProviderAccountId: 'contractor-cash',
        },
        {
          id: 'south-city',
          serviceCapacity: { care: 2 },
          serviceProvisionCost: 0,
          serviceAccountId: 'house-cash',
          serviceProviderAccountId: 'contractor-cash',
        },
      ],
      cohorts: [],
      routes: [],
      carrierAccountId: 'carrier-cash',
      migrationFundingAccountId: 'migration-fund',
      migrationBudget: 0,
    });
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
    });
    engine.step();
    engine.submit({
      commandId: 'city-capital',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'capital-investment',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'care-upgrade',
        targetCityId: 'north-city',
        service: 'care',
        contractorAccountId: 'contractor-cash',
        cost: 5,
        capacityIncrease: 3,
        effectiveTick: 3,
        expiryTick: 4,
      },
    });
    engine.submit({
      commandId: 'capital-overlap',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'capital-investment',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'care-overlap',
        targetCityId: 'north-city',
        service: 'care',
        contractorAccountId: 'contractor-cash',
        cost: 1,
        capacityIncrease: 996,
        effectiveTick: 3,
        expiryTick: 4,
      },
    });
    for (const [commandId, service, effectiveTick, expiryTick] of [
      ['capital-past', 'care', 1, 1],
      ['capital-expired', 'care', 3, 2],
      ['capital-unavailable-service', 'transport', 3, 4],
    ] as const) {
      engine.submit({
        commandId,
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'capital-investment',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: commandId,
          targetCityId: 'north-city',
          service,
          contractorAccountId: 'contractor-cash',
          cost: 1,
          capacityIncrease: 1,
          effectiveTick,
          expiryTick,
        },
      });
    }
    for (const [commandId, targetCityId, cost, governmentId] of [
      ['capital-unfunded', 'north-city', 21, 'north'],
      ['capital-wrong-jurisdiction', 'south-city', 1, 'north'],
    ] as const) {
      engine.submit({
        commandId,
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'capital-investment',
          kingdomId: governmentId,
          governmentId,
          policyId: commandId,
          targetCityId,
          service: 'care',
          contractorAccountId: 'contractor-cash',
          cost,
          capacityIncrease: 1,
          effectiveTick: 3,
          expiryTick: 4,
        },
      });
    }
    engine.step();
    const accounting = () =>
      engine.getState().domain.accounting as {
        accounts: Array<{ id: string; balance: number }>;
        journal: Array<{ causeId: string }>;
      };
    const capacity = () =>
      (
        engine.getState().domain.cities as {
          cities: Record<string, { serviceCapacity: Record<string, number> }>;
        }
      ).cities['north-city']!.serviceCapacity.care;
    expect(engine.receipts().find((r) => r.commandId === 'city-capital')?.status).toBe('applied');
    expect(engine.receipts().find((r) => r.commandId === 'capital-overlap')?.status).toBe(
      'rejected',
    );
    for (const commandId of ['capital-past', 'capital-expired', 'capital-unavailable-service']) {
      expect(engine.receipts().find((receipt) => receipt.commandId === commandId)?.status).toBe(
        'rejected',
      );
    }
    expect(engine.receipts().find((r) => r.commandId === 'capital-unfunded')?.status).toBe(
      'rejected',
    );
    expect(
      engine.receipts().find((r) => r.commandId === 'capital-wrong-jurisdiction')?.status,
    ).toBe('rejected');
    expect(capacity()).toBe(2);
    expect(accounting().accounts).toEqual(
      expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 15 },
        { id: 'contractor-cash', ownerId: 'contractor', balance: 5 },
      ]),
    );
    expect(accounting().journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ causeId: 'government:care-upgrade:contract' }),
      ]),
    );
    const replayStart = engine.snapshot();
    engine.step();
    expect(capacity()).toBe(5);
    engine.step();
    expect(capacity()).toBe(5);
    engine.step();
    expect(capacity()).toBe(2);
    expect(
      accounting().journal.filter((entry) => entry.causeId === 'government:care-upgrade:contract'),
    ).toHaveLength(1);
    const expectedFinal = engine.snapshotText();
    engine.restore(replayStart);
    engine.run(3);
    expect(engine.snapshotText()).toBe(expectedFinal);
  });

  it('funds delayed road capacity and preserves in-flight throughput through expiry', () => {
    const engine = createEngine({ initialState: {} }, 112);
    registerDiplomacy(engine, offerConfig(0));
    registerLogistics(engine, {
      ...logistics,
      accounts: [
        ...logistics.accounts.map((item) =>
          item.id === 'north-cash' ? { ...item, openingBalance: 20 } : item,
        ),
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'north', commodity: 'grain', quantity: 10 }],
      routes: [
        ...logistics.routes.map((route) => ({ ...route, capacity: 1, travelTicks: 4 })),
        {
          routeId: 'south-road',
          sourceCityId: 'south-city',
          destinationCityId: 'north-city',
          travelTicks: 4,
          capacity: 1,
          fare: 2,
          carrierAccountId: 'carrier-cash',
        },
      ],
    });
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
    });
    engine.step();
    const submitDeparture = (id: string, tick: number) =>
      engine.submit({
        commandId: id,
        type: 'logistics.depart',
        requestedTick: tick,
        payload: {
          shipmentId: id,
          routeId: 'road',
          commodity: 'grain',
          quantity: 1,
          buyerAccountId: 'north-cash',
          payment: 2,
        },
      });
    engine.submit({
      commandId: 'permit-road',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: { offerId: 'grain-road', kingdomId: 'north', accepted: true, reason: 'trade' },
    });
    submitDeparture('baseline-throughput', 2);
    engine.step();
    engine.submit({
      commandId: 'road-investment',
      type: 'government.policy',
      requestedTick: 3,
      payload: {
        variant: 'capital-investment',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'road-upgrade',
        targetRouteId: 'road',
        carrierAccountId: 'carrier-cash',
        cost: 5,
        capacityIncrease: 1,
        effectiveTick: 4,
        expiryTick: 4,
      },
    });
    for (const [commandId, policyId, targetRouteId, carrierAccountId, cost, capacityIncrease] of [
      ['wrong-road-kingdom', 'wrong-road-kingdom', 'south-road', 'carrier-cash', 1, 1],
      ['wrong-road-carrier', 'wrong-road-carrier', 'road', 'north-cash', 1, 1],
      ['empty-road-treasury', 'empty-road-treasury', 'road', 'carrier-cash', 16, 1],
      ['overlapping-road-cap', 'overlapping-road-cap', 'road', 'carrier-cash', 1, 999],
    ] as const) {
      engine.submit({
        commandId,
        type: 'government.policy',
        requestedTick: 3,
        payload: {
          variant: 'capital-investment',
          kingdomId: 'north',
          governmentId: 'north',
          policyId,
          targetRouteId,
          carrierAccountId,
          cost,
          capacityIncrease,
          effectiveTick: 4,
          expiryTick: 4,
        },
      });
    }
    engine.step();
    for (const commandId of [
      'wrong-road-kingdom',
      'wrong-road-carrier',
      'empty-road-treasury',
      'overlapping-road-cap',
    ])
      expect(engine.receipts().find((r) => r.commandId === commandId)?.status).toBe('rejected');
    const replayStart = engine.snapshot();
    submitDeparture('bonus-throughput', 4);
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'bonus-throughput')?.status).toBe(
      'applied',
    );
    engine.step();
    const state = engine.getState().domain as {
      government: { investments: Array<{ applied: boolean; expired: boolean }> };
      accounting: { journal: Array<{ causeId: string }> };
    };
    expect(state.government.investments).toEqual([
      expect.objectContaining({ applied: true, expired: true }),
    ]);
    expect(
      state.accounting.journal.filter(
        (entry) => entry.causeId === 'government:road-upgrade:contract',
      ),
    ).toHaveLength(1);
    submitDeparture('after-expiry', 6);
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'after-expiry')?.status).toBe('rejected');
    const expectedFinal = engine.snapshotText();
    engine.restore(replayStart);
    submitDeparture('bonus-throughput', 4);
    engine.step();
    engine.step();
    submitDeparture('after-expiry', 6);
    engine.step();
    expect(engine.snapshotText()).toBe(expectedFinal);
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
  it('assesses an import tariff atomically on an eligible shipment and replays deterministically', () => {
    const setup = () => {
      const engine = createEngine({ initialState: {} }, 71);
      registerDiplomacy(engine, offerConfig(0));
      registerGovernment(engine, {
        kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      });
      registerLogistics(engine, {
        ...logistics,
        accounts: [
          ...logistics.accounts,
          { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        ],
      });
      engine.step();
      engine.submit({
        commandId: 'permit',
        type: 'diplomacy.decision',
        requestedTick: 2,
        payload: { offerId: 'grain-road', kingdomId: 'north', accepted: true, reason: 'trade' },
      });
      engine.submit({
        commandId: 'tariff',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'import-tariff',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'tariff-1',
          importKingdomId: 'south',
          routeId: 'road',
          commodity: 'grain',
          amount: 3,
          effectiveTick: 2,
          expiryTick: 5,
        },
      });
      engine.submit({
        commandId: 'wrong-kingdom-tariff',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'import-tariff',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'wrong-kingdom',
          importKingdomId: 'north',
          routeId: 'road',
          commodity: 'grain',
          amount: 4,
          effectiveTick: 2,
          expiryTick: 5,
        },
      });
      engine.submit({
        commandId: 'wrong-commodity-tariff',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'import-tariff',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'wrong-commodity',
          importKingdomId: 'south',
          routeId: 'road',
          commodity: 'ore',
          amount: 5,
          effectiveTick: 2,
          expiryTick: 5,
        },
      });
      engine.submit({
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
      engine.step();
      return engine;
    };
    const engine = setup();
    expect(engine.receipts().find((r) => r.commandId === 'tariff')?.status).toBe('rejected');
    expect(engine.receipts().find((r) => r.commandId === 'shipment')?.status).toBe('applied');
    const state = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      journal: Array<{ causeId: string; type: string; effects: unknown[] }>;
    };
    expect(state.accounts).toEqual(
      expect.arrayContaining([
        { id: 'north-cash', ownerId: 'north', balance: 8 },
        { id: 'south-cash', ownerId: 'south', balance: 0 },
        { id: 'carrier-cash', ownerId: 'carrier', balance: 2 },
      ]),
    );
    expect(state.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'payment', causeId: 'logistics:shipment:fare' }),
      ]),
    );
    const restored = createEngine({ initialState: {} }, 71);
    registerDiplomacy(restored, offerConfig(0));
    registerGovernment(restored, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
    });
    registerLogistics(restored, {
      ...logistics,
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
    });
    restored.restore(engine.snapshot());
    engine.run(2);
    restored.run(2);
    expect(restored.snapshotText()).toBe(engine.snapshotText());
  });

  it('scopes and expires trade restrictions without stopping in-flight shipments', () => {
    const engine = createEngine({ initialState: {} }, 72);
    registerDiplomacy(engine, offerConfig(0));
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
    });
    registerLogistics(engine, {
      ...logistics,
      routes: logistics.routes.map((route) => ({ ...route, travelTicks: 3 })),
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
    });
    engine.step();
    engine.submit({
      commandId: 'permit',
      type: 'diplomacy.decision',
      requestedTick: 2,
      payload: { offerId: 'grain-road', kingdomId: 'north', accepted: true, reason: 'trade' },
    });
    engine.submit({
      commandId: 'already-inflight',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'already-inflight',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'north-cash',
        payment: 2,
      },
    });
    engine.submit({
      commandId: 'wrong-kingdom-restriction',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'trade-restriction',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'restrict-wrong-kingdom',
        importKingdomId: 'north',
        routeId: 'road',
        commodity: 'grain',
        effectiveTick: 2,
        expiryTick: 2,
      },
    });
    engine.submit({
      commandId: 'wrong-commodity-restriction',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'trade-restriction',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'restrict-wrong-commodity',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'ore',
        effectiveTick: 2,
        expiryTick: 2,
      },
    });
    engine.submit({
      commandId: 'restriction',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'trade-restriction',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'restrict-grain',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        effectiveTick: 2,
        expiryTick: 2,
      },
    });
    engine.submit({
      commandId: 'blocked',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'blocked',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'north-cash',
        payment: 2,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'already-inflight')?.status).toBe(
      'applied',
    );
    expect(engine.receipts().find((r) => r.commandId === 'restriction')?.status).toBe('rejected');
    expect(engine.receipts().find((r) => r.commandId === 'blocked')?.status).toBe('applied');
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [
        expect.objectContaining({ shipmentId: 'already-inflight', status: 'in-transit' }),
        expect.objectContaining({ shipmentId: 'blocked', status: 'in-transit' }),
      ],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([{ id: 'north-cash', ownerId: 'north', balance: 6 }]),
      stock: expect.arrayContaining([
        expect.objectContaining({
          ownerId: 'north',
          commodity: 'grain',
          quantity: 1,
          location: 'available',
        }),
      ]),
    });
    engine.submit({
      commandId: 'expired-ok',
      type: 'logistics.depart',
      requestedTick: 3,
      payload: {
        shipmentId: 'expired-ok',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'north-cash',
        payment: 2,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'expired-ok')?.status).toBe('applied');
    expect(
      (
        engine.getState().domain.logistics as {
          shipments: Array<{ shipmentId: string; status: string }>;
        }
      ).shipments,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shipmentId: 'already-inflight', status: 'in-transit' }),
        expect.objectContaining({ shipmentId: 'expired-ok' }),
      ]),
    );
  });

  it('rolls back institution-rejected trade policy commands', () => {
    const engine = createEngine({ initialState: {} }, 73);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      institutions: { north: 'parliamentary' },
    });
    registerLogistics(engine, {
      ...logistics,
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
    });
    engine.step();
    engine.submit({
      commandId: 'vetoed-tariff',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'import-tariff',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'vetoed',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
        expiryTick: 4,
        legitimacy: 90,
        quorum: 90,
        support: 90,
        oppositionVeto: true,
      },
    });
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'vetoed-tariff')?.status).toBe(
      'rejected',
    );
    expect(engine.getState().domain.government).toMatchObject({
      tradePolicies: [],
      authorityDecisions: [],
    });
  });

  it('records a rejected guarantee and rationale when the treasury is empty', () => {
    const engine = createEngine({ initialState: {} }, 12);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north' },
    });
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'farm'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 0 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 1 }],
      recipes: [],
      producers: [],
      cohorts: [
        {
          id: 'families',
          cityId: 'north-city',
          ownerId: 'north',
          accountId: 'north-households',
          workersAvailable: 0,
          desiredNeeds: {},
        },
      ],
      sellers: [],
    });
    engine.step();
    engine.submit({
      commandId: 'unfunded-food-support',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'food-subsidy',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'unfunded-food-support',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north',
        recipientAccountId: 'north-households',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
      },
    });
    engine.step();
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'unfunded-food-support')?.status,
    ).toBe('applied');
    expect(engine.getState().domain.government).toMatchObject({
      policies: [],
      decisions: [
        expect.objectContaining({
          policyId: 'unfunded-food-support',
          selected: 'reject',
          reason: expect.stringContaining('insufficient treasury for guarantee'),
        }),
      ],
    });
  });

  it('pays food subsidy only on real grain purchases and expires after 60 effective ticks', () => {
    const engine = createEngine({ initialState: {} }, 11);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north' },
    });
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'north-household', 'south', 'farm'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 20 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'household-cash', ownerId: 'north-household', openingBalance: 4 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 3 }],
      recipes: [],
      producers: [],
      cohorts: [
        {
          id: 'families',
          cityId: 'north-city',
          ownerId: 'north-household',
          accountId: 'household-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
      ],
      sellers: [
        {
          cityId: 'north-city',
          commodity: 'grain',
          ownerId: 'farm',
          accountId: 'farm-cash',
          minPrice: 2,
          maxPrice: 2,
          openingPrice: 2,
        },
      ],
    });
    engine.step();
    engine.submit({
      commandId: 'food-support',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'food-subsidy',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'food-support',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north-household',
        recipientAccountId: 'household-cash',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
        expiryTick: 61,
      },
    });
    engine.submit({
      commandId: 'later-food-support',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'food-subsidy',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'later-food-support',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north-household',
        recipientAccountId: 'household-cash',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 62,
        expiryTick: 63,
      },
    });
    engine.submit({
      commandId: 'duplicate-food-support',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'food-subsidy',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'duplicate-food-support',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north-household',
        recipientAccountId: 'household-cash',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
        expiryTick: 61,
      },
    });
    engine.run(60);
    expect(engine.receipts().find((receipt) => receipt.commandId === 'food-support')?.status).toBe(
      'applied',
    );
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'duplicate-food-support')?.status,
    ).toBe('rejected');
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'later-food-support')?.status,
    ).toBe('applied');
    const state = engine.getState().domain as {
      accounting: {
        accounts: Array<{ id: string; balance: number }>;
        stock: Array<{ ownerId: string; commodity: string; quantity: number }>;
        journal: Array<{ type: string; causeId: string }>;
      };
      government: {
        policies: Array<{ variant?: string; expiryTick: number }>;
        decisions: Array<{ reason: string }>;
      };
    };
    expect(state.government.policies).toContainEqual(
      expect.objectContaining({ variant: 'food-subsidy', expiryTick: 61 }),
    );
    expect(state.accounting.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'north-cash', balance: 19 }),
        expect.objectContaining({ id: 'household-cash', balance: 1 }),
        expect.objectContaining({ id: 'farm-cash', balance: 4 }),
      ]),
    );
    expect(
      state.accounting.stock.find((item) => item.ownerId === 'farm' && item.commodity === 'grain')
        ?.quantity,
    ).toBe(1);
    expect(state.accounting.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'payment', causeId: 'purchase:families:grain' }),
        expect.objectContaining({
          type: 'payment',
          causeId: 'government:food-support:purchase:families:grain',
        }),
      ]),
    );
    expect(
      state.accounting.journal.filter(
        (entry) => entry.causeId === 'government:food-support:purchase:families:grain',
      ),
    ).toHaveLength(1);
    const total = state.accounting.accounts.reduce((sum, account) => sum + account.balance, 0);
    expect(total).toBe(24);
    expect(state.government.decisions.some((decision) => decision.reason)).toBe(true);
    engine.step();
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: 'north-cash', balance: 19 }),
        expect.objectContaining({ id: 'household-cash', balance: 1 }),
      ]),
    });
  });

  it('applies a bounded jurisdiction tax to real local purchases atomically and replays it', () => {
    const setup = (incidence: 'buyer' | 'seller' = 'buyer') => {
      const engine = createEngine({ initialState: {} }, 90);
      registerGovernment(engine, {
        kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
        cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
      });
      const economy = {
        currency: { id: 'coin', unit: 'coin', scale: 0 },
        commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
        owners: ['north', 'south', 'household', 'farm'],
        accounts: [
          { id: 'north-cash', ownerId: 'north', openingBalance: 20 },
          { id: 'north-households', ownerId: 'north', openingBalance: 0 },
          { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
          { id: 'household-cash', ownerId: 'household', openingBalance: 10 },
          { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
        ],
        stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 3 }],
        recipes: [],
        producers: [],
        cohorts: [
          {
            id: 'families',
            cityId: 'north-city',
            ownerId: 'household',
            accountId: 'household-cash',
            workersAvailable: 0,
            desiredNeeds: { grain: 1 },
          },
        ],
        sellers: [
          {
            cityId: 'north-city',
            commodity: 'grain',
            ownerId: 'farm',
            accountId: 'farm-cash',
            minPrice: 2,
            maxPrice: 2,
            openingPrice: 2,
          },
        ],
      };
      registerLocalEconomy(engine, economy);
      engine.step();
      engine.submit({
        commandId: 'local-tax',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'local-purchase-tax',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'north-tax',
          rateBps: 5000,
          incidence,
          effectiveTick: 2,
          expiryTick: 2,
          legitimacy: 90,
          quorum: 90,
          support: 90,
          oppositionVeto: false,
        },
      });
      engine.submit({
        commandId: 'later-local-tax',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'local-purchase-tax',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'north-tax-later',
          rateBps: 5000,
          incidence,
          effectiveTick: 3,
          expiryTick: 3,
          legitimacy: 90,
          quorum: 90,
          support: 90,
          oppositionVeto: false,
        },
      });
      engine.submit({
        commandId: 'overlapping-local-tax',
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'local-purchase-tax',
          kingdomId: 'north',
          governmentId: 'north',
          policyId: 'north-tax-overlap',
          rateBps: 5000,
          incidence,
          effectiveTick: 2,
          expiryTick: 3,
          legitimacy: 90,
          quorum: 90,
          support: 90,
          oppositionVeto: false,
        },
      });
      engine.step();
      return engine;
    };
    const engine = setup();
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'overlapping-local-tax')?.status,
    ).toBe('rejected');
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'later-local-tax')?.status,
    ).toBe('applied');
    const state = engine.getState().domain as {
      accounting: {
        accounts: Array<{ id: string; balance: number }>;
        stock: Array<{ ownerId: string; quantity: number }>;
        journal: Array<{ causeId: string; transactionId: string }>;
      };
      government: { taxPolicies: unknown[] };
    };
    expect(state.government.taxPolicies).toHaveLength(2);
    expect(state.accounting.accounts).toEqual(
      expect.arrayContaining([
        { id: 'household-cash', ownerId: 'household', balance: 5 },
        { id: 'farm-cash', ownerId: 'farm', balance: 4 },
        { id: 'north-cash', ownerId: 'north', balance: 21 },
      ]),
    );
    expect(state.accounting.stock.find((item) => item.ownerId === 'farm')?.quantity).toBe(1);
    expect(state.accounting.accounts.reduce((sum, account) => sum + account.balance, 0)).toBe(30);
    expect(
      state.accounting.accounts.find((account) => account.id === 'household-cash')!.balance,
    ).toBeGreaterThanOrEqual(0);
    expect(
      10 - state.accounting.accounts.find((account) => account.id === 'household-cash')!.balance,
    ).toBe(
      state.accounting.accounts.find((account) => account.id === 'farm-cash')!.balance +
        state.accounting.accounts.find((account) => account.id === 'north-cash')!.balance -
        20,
    );
    expect(
      state.accounting.journal.filter(
        (entry) => entry.causeId === 'government:north-tax:purchase:families:grain',
      ),
    ).toHaveLength(1);
    const replay = setup();
    replay.restore(engine.snapshot());
    engine.run(2);
    replay.run(2);
    expect(replay.snapshotText()).toBe(engine.snapshotText());
    engine.step();
    expect(
      (
        engine.getState().domain as { accounting: { journal: Array<{ causeId: string }> } }
      ).accounting.journal.filter(
        (entry) => entry.causeId === 'government:north-tax:purchase:families:grain',
      ),
    ).toHaveLength(1);

    const sellerIncidence = setup('seller');
    const sellerState = sellerIncidence.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      journal: Array<{ causeId: string; effects: unknown[] }>;
    };
    const purchase = sellerState.journal.find(
      (entry) => entry.causeId === 'purchase:families:grain',
    )!.effects[0] as { debit: string; credit: string; amount: { minor: number } };
    const taxPayment = sellerState.journal.find(
      (entry) => entry.causeId === 'government:north-tax:purchase:families:grain',
    )!.effects[0] as { debit: string; credit: string; amount: { minor: number } };
    const balance = (id: string) =>
      sellerState.accounts.find((account) => account.id === id)!.balance;
    expect(purchase).toMatchObject({ debit: 'household-cash', credit: 'farm-cash' });
    expect(taxPayment).toMatchObject({ debit: 'farm-cash', credit: 'north-cash' });
    const purchaseValue = 10 - balance('household-cash');
    const taxCollected = balance('north-cash') - 20;
    expect(purchaseValue).toBeGreaterThan(0);
    expect(balance('farm-cash')).toBe(purchaseValue - taxCollected);
    expect(taxCollected).toBeGreaterThan(0);
  });

  it('does not tax local purchases outside the configured government jurisdiction', () => {
    const engine = createEngine({ initialState: {} }, 91);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north', 'south-city': 'south' },
    });
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'north-family', 'south-family', 'farm'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 10 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 10 },
        { id: 'south-households', ownerId: 'south', openingBalance: 0 },
        { id: 'north-family-cash', ownerId: 'north-family', openingBalance: 10 },
        { id: 'south-family-cash', ownerId: 'south-family', openingBalance: 10 },
        { id: 'farm-cash', ownerId: 'farm', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 10 }],
      recipes: [],
      producers: [],
      cohorts: [
        {
          id: 'north-family',
          cityId: 'north-city',
          ownerId: 'north-family',
          accountId: 'north-family-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
        {
          id: 'south-family',
          cityId: 'south-city',
          ownerId: 'south-family',
          accountId: 'south-family-cash',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
      ],
      sellers: [
        {
          cityId: 'north-city',
          commodity: 'grain',
          ownerId: 'farm',
          accountId: 'farm-cash',
          minPrice: 2,
          maxPrice: 2,
          openingPrice: 2,
        },
        {
          cityId: 'south-city',
          commodity: 'grain',
          ownerId: 'farm',
          accountId: 'farm-cash',
          minPrice: 2,
          maxPrice: 2,
          openingPrice: 2,
        },
      ],
    });
    engine.step();
    engine.submit({
      commandId: 'north-only-tax',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'local-purchase-tax',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'north-only',
        rateBps: 5000,
        incidence: 'buyer',
        effectiveTick: 2,
        expiryTick: 2,
      },
    });
    engine.step();
    const accounting = engine.getState().domain.accounting as {
      accounts: Array<{ id: string; balance: number }>;
      journal: Array<{ causeId: string }>;
    };
    expect(accounting.accounts.find((account) => account.id === 'north-cash')?.balance).toBe(11);
    expect(
      accounting.journal.filter((entry) =>
        entry.causeId.startsWith('government:north-only:purchase:'),
      ),
    ).toHaveLength(1);
    expect(
      accounting.journal.some(
        (entry) => entry.causeId === 'government:north-only:purchase:south-family:grain',
      ),
    ).toBe(false);
  });

  it('reserves overlapping food guarantees and rejects treasury overcommitment', () => {
    const engine = createEngine({ initialState: {} }, 92);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north' },
    });
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'family', 'family-two'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 10 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'family-cash', ownerId: 'family', openingBalance: 0 },
        { id: 'family-two-cash', ownerId: 'family-two', openingBalance: 0 },
      ],
      cohorts: [
        {
          id: 'family',
          cityId: 'north-city',
          ownerId: 'family',
          accountId: 'family-cash',
          workersAvailable: 0,
          desiredNeeds: {},
        },
        {
          id: 'family-two',
          cityId: 'north-city',
          ownerId: 'family-two',
          accountId: 'family-two-cash',
          workersAvailable: 0,
          desiredNeeds: {},
        },
      ],
      producers: [],
      sellers: [],
      stock: [],
    });
    engine.step();
    const submit = (
      commandId: string,
      policyId: string,
      amount: number,
      effectiveTick: number,
      expiryTick: number,
      recipientOwnerId = 'family',
      recipientAccountId = 'family-cash',
    ) =>
      engine.submit({
        commandId,
        type: 'government.policy',
        requestedTick: 2,
        payload: {
          variant: 'food-subsidy',
          kingdomId: 'north',
          governmentId: 'north',
          policyId,
          recipientKingdomId: 'north',
          recipientOwnerId,
          recipientAccountId,
          commodity: 'grain',
          amount,
          effectiveTick,
          expiryTick,
        },
      });
    submit('guarantee-a', 'guarantee-a', 6, 2, 5);
    submit('guarantee-b', 'guarantee-b', 6, 2, 5, 'family-two', 'family-two-cash');
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'guarantee-a')?.status).toBe(
      'applied',
    );
    expect(engine.receipts().find((receipt) => receipt.commandId === 'guarantee-b')?.status).toBe(
      'applied',
    );
    expect(engine.getState().domain.government).toMatchObject({
      policies: [expect.objectContaining({ policyId: 'guarantee-a' })],
      decisions: [expect.objectContaining({ policyId: 'guarantee-b', selected: 'reject' })],
    });
  });

  it('keeps the default food subsidy duration after institutional delay', () => {
    const engine = createEngine({ initialState: {} }, 93);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
      cityKingdomIds: { 'north-city': 'north' },
      institutions: { north: 'parliamentary' },
    });
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
      owners: ['north', 'south', 'family'],
      accounts: [
        { id: 'north-cash', ownerId: 'north', openingBalance: 10 },
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'family-cash', ownerId: 'family', openingBalance: 0 },
      ],
      cohorts: [
        {
          id: 'family',
          cityId: 'north-city',
          ownerId: 'family',
          accountId: 'family-cash',
          workersAvailable: 0,
          desiredNeeds: {},
        },
      ],
      producers: [],
      sellers: [],
      stock: [],
    });
    engine.step();
    engine.submit({
      commandId: 'delayed-food',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'food-subsidy',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'delayed-food',
        recipientKingdomId: 'north',
        recipientOwnerId: 'family',
        recipientAccountId: 'family-cash',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
        legitimacy: 90,
        quorum: 90,
        support: 90,
        oppositionVeto: false,
      },
    });
    engine.step();
    expect(engine.getState().domain.government).toMatchObject({
      policies: [
        expect.objectContaining({ policyId: 'delayed-food', effectiveTick: 5, expiryTick: 64 }),
      ],
    });
  });

  it('rejects policy IDs already used by another policy variant', () => {
    const engine = createEngine({ initialState: {} }, 94);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: [...kingdoms[0]!.recipients] }, kingdoms[1]!],
    });
    registerLogistics(engine, {
      ...logistics,
      accounts: [
        ...logistics.accounts,
        { id: 'north-households', ownerId: 'north', openingBalance: 0 },
      ],
    });
    engine.step();
    engine.submit({
      commandId: 'first-variant',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'shared-id',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north',
        recipientAccountId: 'north-households',
        amount: 1,
        effectiveTick: 2,
        expiryTick: 3,
      },
    });
    engine.submit({
      commandId: 'second-variant',
      type: 'government.policy',
      requestedTick: 2,
      payload: {
        variant: 'import-tariff',
        kingdomId: 'north',
        governmentId: 'north',
        policyId: 'shared-id',
        importKingdomId: 'south',
        routeId: 'road',
        commodity: 'grain',
        amount: 1,
        effectiveTick: 2,
        expiryTick: 3,
      },
    });
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'first-variant')?.status).toBe(
      'applied',
    );
    expect(
      engine.receipts().find((receipt) => receipt.commandId === 'second-variant')?.status,
    ).toBe('rejected');
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
