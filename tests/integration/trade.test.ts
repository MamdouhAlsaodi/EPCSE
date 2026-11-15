import { describe, expect, it } from 'vitest';
import {
  createEngine,
  createInventory,
  createMoneyLedger,
  createPaidShipmentCoordinator,
  createRouteNetwork,
  registerLocalEconomy,
  registerLogistics,
} from '../../packages/simulation-core/src/index.js';
import {
  pauseRouteShipment,
  resumeRouteShipment,
} from '../../packages/simulation-core/src/services/logistics/route-rules.js';

const config = {
  currency: { id: 'coin', unit: 'coin', scale: 0 },
  commodities: [{ id: 'grain', unit: 'unit', scale: 0 }],
  owners: ['north', 'south', 'carrier', 'transit'],
  accounts: [
    { id: 'buyer', ownerId: 'north', openingBalance: 20 },
    { id: 'carrier-account', ownerId: 'carrier', openingBalance: 0 },
  ],
  stock: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
  transitOwnerId: 'transit',
  cities: ['north', 'south'],
  routes: [
    {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 2,
      capacity: 5,
      fare: 4,
      carrierAccountId: 'carrier-account',
    },
  ],
};

describe('shared logistics route rules', () => {
  it('preserves active travel time when pausing and resuming a shipment', () => {
    const paused = pauseRouteShipment({ arrivalTick: 9 }, 4);
    expect(paused).toEqual({ arrivalTick: 9, pausedRemainingTicks: 5 });
    expect(resumeRouteShipment(paused, 7)).toEqual({ arrivalTick: 12 });
  });
});

describe('shared logistics route rules', () => {
  it('applies paid obstruction reroute eligibility and return timing through both APIs', () => {
    const legacyInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    const legacyMoney = createMoneyLedger({
      accounts: ['buyer', 'carrier'],
      balances: [{ accountId: 'buyer', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 3 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 2 },
    ];
    const legacy = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory: legacyInventory,
      routes,
    });
    const paid = createPaidShipmentCoordinator({
      inventory: legacyInventory,
      money: legacyMoney,
      network: legacy,
    });
    paid.depart({
      shipment: { shipmentId: 'legacy', routeId: 'road', commodity: 'grain', quantity: 1 },
      buyerAccountId: 'buyer',
      sellerAccountId: 'carrier',
      payment: 1,
    });
    legacy.blockRoute('road');
    paid.reroute({ shipmentId: 'legacy', routeId: 'river', payment: 1 });
    expect(legacy.getState().shipments[0]).toMatchObject({
      routeId: 'river',
      status: 'in-transit',
    });
    legacy.advanceTick();
    legacy.attackRoute('river');
    expect(legacy.getState().shipments[0]).toMatchObject({ status: 'returning', returnDueTick: 2 });

    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, {
      ...config,
      owners: [...config.owners, 'east'],
      cities: ['north', 'south', 'east'],
      stock: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
      routes: routes.map((route) => ({
        ...route,
        capacity: 5,
        fare: 1,
        carrierAccountId: 'carrier-account',
      })),
    });
    const command = (commandId: string, type: string, requestedTick: number, payload: unknown) =>
      engine.submit({ commandId, type, requestedTick, payload });
    command('departure', 'logistics.depart', 1, {
      shipmentId: 'engine',
      routeId: 'road',
      commodity: 'grain',
      quantity: 1,
      buyerAccountId: 'buyer',
      payment: 1,
    });
    engine.step();
    command('block', 'logistics.route.block', 2, { routeId: 'road' });
    engine.step();
    command('reroute', 'logistics.reroute', 3, {
      shipmentId: 'engine',
      routeId: 'river',
      payment: 1,
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ routeId: 'river', status: 'in-transit' }],
    });
    command('attack', 'logistics.route.attack', 4, { routeId: 'river' });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returning', returnDueTick: 6 }],
    });
  });
});

describe('engine logistics integration', () => {
  it('pauses an in-flight delivery during route closure and resumes it after reopening', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'departure',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'shipment',
        routeId: 'road',
        commodity: 'grain',
        quantity: 3,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.submit({
      commandId: 'close',
      type: 'logistics.route.close',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.run(2);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit' }],
    });
    engine.submit({
      commandId: 'open',
      type: 'logistics.route.open',
      requestedTick: 3,
      payload: { routeId: 'road' },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit' }],
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'arrived' }],
    });
  });

  it('counts one outward tick before an attack on the due tick and returns one tick later', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, { ...config, routes: [{ ...config.routes[0]!, travelTicks: 1 }] });
    engine.submit({
      commandId: 'd',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'one-tick',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'a',
      type: 'logistics.route.attack',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returning', returnDueTick: 3 }],
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returned' }],
    });
  });

  it('returns cargo after active outward ticks when a route is attacked without refunding fare', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'departure',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'shipment',
        routeId: 'road',
        commodity: 'grain',
        quantity: 3,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'attack',
      type: 'logistics.route.attack',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returning', attackTick: 2, returnDueTick: 3 }],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'buyer', ownerId: 'north', balance: 16 },
        { id: 'carrier-account', ownerId: 'carrier', balance: 4 },
      ]),
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returned' }],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'north', commodity: 'grain', location: 'available', quantity: 5 },
      ]),
    });
  });

  it('reserves capacity and rejects an over-capacity departure without changing accounting or route state', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, { ...config, routes: [{ ...config.routes[0]!, capacity: 3 }] });
    engine.submit({
      commandId: 'one',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'one',
        routeId: 'road',
        commodity: 'grain',
        quantity: 3,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    const before = engine.getState().domain;
    engine.submit({
      commandId: 'two',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'two',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'two')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toEqual(before.accounting);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ shipmentId: 'one' }],
    });
  });

  it('supports obstruction wait and return without refunding the initial fare', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    engine.submit({
      commandId: 'wait',
      type: 'logistics.shipment.wait',
      requestedTick: 3,
      payload: { shipmentId: 's' },
    });
    expect(engine.step().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit', routeId: 'road' }],
    });
    engine.submit({
      commandId: 'return',
      type: 'logistics.shipment.return',
      requestedTick: 4,
      payload: { shipmentId: 's' },
    });
    engine.run(2);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returned' }],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'buyer', ownerId: 'north', balance: 16 },
        { id: 'carrier-account', ownerId: 'carrier', balance: 4 },
      ]),
      stock: expect.arrayContaining([
        { ownerId: 'north', commodity: 'grain', location: 'available', quantity: 5 },
      ]),
    });
  });

  it('reroutes a paid obstruction to an eligible third city and charges the carrier again', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, {
      ...config,
      cities: ['north', 'south', 'east'],
      owners: ['north', 'south', 'east', 'carrier', 'transit'],
      routes: [
        ...config.routes,
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 2,
          capacity: 3,
          fare: 3,
          carrierAccountId: 'carrier-account',
        },
      ],
    });
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    engine.submit({
      commandId: 'reroute',
      type: 'logistics.reroute',
      requestedTick: 3,
      payload: { shipmentId: 's', routeId: 'river', payment: 3 },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [
        { routeId: 'river', reroutedFromRouteId: 'road', rerouteRemainingTicks: 1, arrivalTick: 6 },
      ],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'buyer', ownerId: 'north', balance: 13 },
        { id: 'carrier-account', ownerId: 'carrier', balance: 7 },
      ]),
    });
    engine.run(2);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit' }],
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'arrived' }],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'east', commodity: 'grain', location: 'available', quantity: 2 },
      ]),
    });
  });

  it('rejects a second reroute atomically and restores deterministic route/accounting state', () => {
    const cfg = {
      ...config,
      cities: ['north', 'south', 'east', 'west'],
      owners: ['north', 'south', 'east', 'west', 'carrier', 'transit'],
      routes: [
        ...config.routes,
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 2,
          capacity: 5,
          fare: 3,
          carrierAccountId: 'carrier-account',
        },
        {
          routeId: 'canal',
          sourceCityId: 'north',
          destinationCityId: 'west',
          travelTicks: 1,
          capacity: 5,
          fare: 2,
          carrierAccountId: 'carrier-account',
        },
      ],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, cfg);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    engine.submit({
      commandId: 'reroute',
      type: 'logistics.reroute',
      requestedTick: 3,
      payload: { shipmentId: 's', routeId: 'river', payment: 3 },
    });
    engine.step();
    engine.submit({
      commandId: 'block2',
      type: 'logistics.route.block',
      requestedTick: 4,
      payload: { routeId: 'river' },
    });
    engine.step();
    const before = engine.getState().domain;
    engine.submit({
      commandId: 'reroute2',
      type: 'logistics.reroute',
      requestedTick: 5,
      payload: { shipmentId: 's', routeId: 'canal', payment: 2 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'reroute2')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toEqual(before.accounting);
    const snapshot = engine.snapshotText();
    const restored = createEngine({ initialState: {} }, 1);
    registerLogistics(restored, cfg);
    restored.restore(snapshot);
    expect(restored.snapshotText()).toBe(snapshot);
    engine.run(4);
    restored.run(4);
    expect(restored.snapshotText()).toBe(engine.snapshotText());
  });

  it('rejects insufficient fare and unpaid departures without partial engine-domain changes', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'poor',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'poor',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 21,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'poor')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'buyer', ownerId: 'north', balance: 20 },
        { id: 'carrier-account', ownerId: 'carrier', balance: 0 },
      ]),
    });
    engine.submit({
      commandId: 'unpaid',
      type: 'logistics.depart',
      requestedTick: 2,
      payload: {
        shipmentId: 'unpaid',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        payment: 4,
      },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unpaid')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.logistics).toMatchObject({ shipments: [] });
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'north', commodity: 'grain', location: 'available', quantity: 5 },
      ]),
    });
  });

  it('rejects an invalid or full alternate route without charging the second fare', () => {
    const engine = createEngine({ initialState: {} }, 1);
    const cfg = {
      ...config,
      cities: ['north', 'south', 'east'],
      owners: ['north', 'south', 'east', 'carrier', 'transit'],
      routes: [
        ...config.routes,
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 2,
          capacity: 1,
          fare: 3,
          carrierAccountId: 'carrier-account',
        },
      ],
    };
    registerLogistics(engine, cfg);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    const before = engine.getState().domain.accounting;
    engine.submit({
      commandId: 'unknown-route',
      type: 'logistics.reroute',
      requestedTick: 3,
      payload: { shipmentId: 's', routeId: 'missing', payment: 3 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unknown-route')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toEqual(before);
    engine.submit({
      commandId: 'reroute',
      type: 'logistics.reroute',
      requestedTick: 4,
      payload: { shipmentId: 's', routeId: 'river', payment: 3 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'reroute')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toEqual(before);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ routeId: 'road', status: 'in-transit' }],
    });
  });

  it('rejects a reroute the original buyer cannot afford without any partial payment', () => {
    const engine = createEngine({ initialState: {} }, 1);
    const cfg = {
      ...config,
      cities: ['north', 'south', 'east'],
      owners: ['north', 'south', 'east', 'carrier', 'transit'],
      routes: [
        ...config.routes,
        {
          routeId: 'costly-river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 2,
          capacity: 5,
          fare: 19,
          carrierAccountId: 'carrier-account',
        },
      ],
    };
    registerLogistics(engine, cfg);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    const before = engine.getState().domain.accounting;
    engine.submit({
      commandId: 'reroute',
      type: 'logistics.reroute',
      requestedTick: 3,
      payload: { shipmentId: 's', routeId: 'costly-river', payment: 19 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'reroute')).toMatchObject({
      status: 'rejected',
    });
    expect(engine.getState().domain.accounting).toEqual(before);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ routeId: 'road', status: 'in-transit' }],
    });
  });

  it('uses explicit city-to-inventory-owner mapping and accepts a buyer at another city', () => {
    const engine = createEngine({ initialState: {} }, 1);
    const mapped = {
      ...config,
      owners: ['farm', 'north', 'south', 'carrier', 'transit'],
      cityOwnerIds: { north: 'farm', south: 'south' },
      accounts: [
        { id: 'buyer', ownerId: 'south', openingBalance: 20 },
        { id: 'carrier-account', ownerId: 'carrier', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'farm', commodity: 'grain', quantity: 5 }],
    };
    registerLogistics(engine, mapped);
    engine.submit({
      commandId: 'mapped',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'mapped',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([{ id: 'buyer', ownerId: 'south', balance: 16 }]),
      stock: expect.arrayContaining([
        {
          ownerId: 'farm',
          commodity: 'grain',
          location: 'transit',
          quantity: 1,
          shipmentId: 'mapped',
        },
      ]),
    });
    engine.run(2);
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'south', commodity: 'grain', location: 'available', quantity: 1 },
      ]),
    });
  });

  it('records physical custody as per-shipment transit stock and arrives through accounting provenance', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'custody',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        {
          ownerId: 'north',
          commodity: 'grain',
          location: 'transit',
          quantity: 2,
          shipmentId: 'custody',
        },
      ]),
      journal: expect.arrayContaining([
        expect.objectContaining({ type: 'reserve' }),
        expect.objectContaining({ type: 'depart' }),
      ]),
    });
    engine.run(2);
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'south', commodity: 'grain', location: 'available', quantity: 2 },
      ]),
      journal: expect.arrayContaining([expect.objectContaining({ type: 'arrive' })]),
    });
  });

  it('settles paid departures in engine state and delivers only at the due tick', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.submit({
      commandId: 'departure',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'shipment',
        routeId: 'road',
        commodity: 'grain',
        quantity: 3,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    expect(engine.step().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit', arrivalTick: 3 }],
    });
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        { id: 'buyer', ownerId: 'north', balance: 16 },
        { id: 'carrier-account', ownerId: 'carrier', balance: 4 },
      ]),
    });
    expect(engine.step().domain.logistics).toMatchObject({ shipments: [{ status: 'in-transit' }] });
    expect(engine.step().domain.logistics).toMatchObject({ shipments: [{ status: 'arrived' }] });
    expect(engine.getState().domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'south', commodity: 'grain', location: 'available', quantity: 3 },
      ]),
    });
  });
  it('returns after one active outward tick when obstruction occurs on the due tick', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, { ...config, routes: [{ ...config.routes[0]!, travelTicks: 1 }] });
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'boundary',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    engine.submit({
      commandId: 'block',
      type: 'logistics.route.block',
      requestedTick: 2,
      payload: { routeId: 'road' },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'in-transit', pausedRemainingTicks: 0 }],
    });
    engine.submit({
      commandId: 'return',
      type: 'logistics.shipment.return',
      requestedTick: 3,
      payload: { shipmentId: 'boundary' },
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returning', returnDueTick: 4 }],
    });
    engine.step();
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'returned' }],
    });
    expect(
      (
        engine.getState().domain.accounting as { accounts: Array<{ id: string; balance: number }> }
      ).accounts.find((a) => a.id === 'carrier-account')?.balance,
    ).toBe(4);
  });

  it('rejects changed route data in a trusted snapshot even with unchanged digest', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, config);
    engine.step();
    const snapshot = engine.snapshot();
    (snapshot.domain.logistics as { routes: Array<{ fare: number }> }).routes[0]!.fare = 999;
    const restored = createEngine({ initialState: {} }, 1);
    registerLogistics(restored, config);
    expect(() => restored.restore(snapshot)).toThrow();
    expect(restored.getState().tick).toBe(0);
  });

  it('rejects restored travel-time acceleration and reroute provenance without its fare', () => {
    const configured = {
      ...config,
      cities: ['north', 'south', 'east'],
      owners: [...config.owners, 'east'],
      routes: [
        ...config.routes,
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 2,
          capacity: 5,
          fare: 3,
          carrierAccountId: 'carrier-account',
        },
      ],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLogistics(engine, configured);
    engine.submit({
      commandId: 'depart',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 's',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.step();
    const early = engine.snapshot();
    (
      early.domain.logistics as { shipments: Array<{ arrivalTick: number }> }
    ).shipments[0]!.arrivalTick = 2;
    const restored = createEngine({ initialState: {} }, 1);
    registerLogistics(restored, configured);
    expect(() => restored.restore(early)).toThrow();
    const unpaidReroute = engine.snapshot();
    const shipment = (
      unpaidReroute.domain.logistics as { shipments: Array<Record<string, unknown>> }
    ).shipments[0]!;
    Object.assign(shipment, {
      routeId: 'river',
      reroutedFromRouteId: 'road',
      reroutedAtTick: 1,
      rerouteRemainingTicks: 2,
      departureTick: 1,
      arrivalTick: 5,
    });
    expect(() => restored.restore(unpaidReroute)).toThrow();
    expect(restored.getState().tick).toBe(0);
  });

  it('composes with the local economy: arrivals feed the destination market on the next tick', () => {
    const shared = {
      ...config,
      commodities: [...config.commodities, { id: 'wood', unit: 'unit', scale: 0 }],
      stock: [...config.stock, { ownerId: 'north', commodity: 'wood', quantity: 5 }],
      owners: [...config.owners, 'north-workers', 'south-workers'],
      accounts: [
        ...config.accounts,
        { id: 'north-wages', ownerId: 'north-workers', openingBalance: 0 },
        { id: 'south-cash', ownerId: 'south', openingBalance: 0 },
        { id: 'south-budget', ownerId: 'south-workers', openingBalance: 10 },
      ],
      recipes: [
        {
          id: 'grain-harvest',
          inputs: [{ commodity: 'wood', quantity: 1 }],
          outputs: [{ commodity: 'grain', quantity: 1 }],
        },
      ],
    };
    const engine = createEngine({ initialState: {} }, 1);
    registerLocalEconomy(engine, {
      ...shared,
      producers: [
        {
          id: 'farm',
          cityId: 'north',
          ownerId: 'north',
          accountId: 'buyer',
          recipeId: 'grain-harvest',
          laborPerBatch: 1,
          maxBatches: 1,
          wagePerBatch: 1,
        },
      ],
      cohorts: [
        {
          id: 'farmhands',
          cityId: 'north',
          ownerId: 'north-workers',
          accountId: 'north-wages',
          workersAvailable: 1,
          desiredNeeds: {},
        },
        {
          id: 'families',
          cityId: 'south',
          ownerId: 'south-workers',
          accountId: 'south-budget',
          workersAvailable: 0,
          desiredNeeds: { grain: 1 },
        },
      ],
      sellers: [
        {
          cityId: 'south',
          commodity: 'grain',
          ownerId: 'south',
          accountId: 'south-cash',
          minPrice: 1,
          maxPrice: 4,
          openingPrice: 2,
        },
      ],
    });
    registerLogistics(engine, shared);
    engine.submit({
      commandId: 'trade',
      type: 'logistics.depart',
      requestedTick: 1,
      payload: {
        shipmentId: 'for-market',
        routeId: 'road',
        commodity: 'grain',
        quantity: 2,
        buyerAccountId: 'buyer',
        payment: 4,
      },
    });
    engine.run(3);
    expect(engine.getState().domain.logistics).toMatchObject({
      shipments: [{ status: 'arrived' }],
    });
    expect(engine.getState().domain.economy).toMatchObject({
      cohorts: { families: { reasons: { grain: 'empty-supply' } } },
    });
    engine.step();
    const domain = engine.getState().domain;
    expect(domain.accounting).toMatchObject({
      stock: expect.arrayContaining([
        { ownerId: 'south', commodity: 'grain', location: 'available', quantity: 1 },
      ]),
      journal: expect.arrayContaining([
        expect.objectContaining({ type: 'arrive' }),
        expect.objectContaining({ type: 'consume' }),
      ]),
    });
    expect(domain.economy).toMatchObject({
      cohorts: { families: { reasons: { grain: 'fulfilled' } } },
    });
  });
});
