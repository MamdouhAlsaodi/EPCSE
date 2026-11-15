import { describe, expect, it } from 'vitest';
import {
  createInventory,
  createMoneyLedger,
  createPaidShipmentCoordinator,
  createRouteNetwork,
} from '../../packages/simulation-core/src/index.js';

const makeShipmentSystem = () => {
  const inventory = createInventory({
    owners: ['north', 'south', 'transit'],
    balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
  });
  const money = createMoneyLedger({
    accounts: ['buyer-cash', 'seller-cash'],
    balances: [{ accountId: 'buyer-cash', amount: 50 }],
  });
  const network = createRouteNetwork({
    cityIds: ['north', 'south'],
    transitOwnerId: 'transit',
    inventory,
    routes: [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 2 },
    ],
  });
  const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
  return { inventory, money, network, coordinator };
};

describe('paid shipments', () => {
  it('reroutes a paid blocked shipment to an open route for an additional fee', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 50 }],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        {
          routeId: 'road',
          sourceCityId: 'north',
          destinationCityId: 'south',
          travelTicks: 4,
          capacity: 2,
        },
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: 3,
          capacity: 2,
        },
      ],
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'rerouted', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 10,
    });
    network.advanceTick();
    network.blockRoute('road');
    network.advanceTick();
    network.advanceTick();

    coordinator.reroute({ shipmentId: 'rerouted', routeId: 'river', payment: 7 });

    expect(network.getState().shipments[0]).toMatchObject({
      routeId: 'river',
      status: 'in-transit',
      arrivalTick: 9,
    });
    network.blockRoute('river');
    const blockedSnapshot = network.getState();
    const blockedInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 3 },
        { ownerId: 'transit', commodity: 'grain', quantity: 2 },
      ],
    });
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory: blockedInventory,
        routes: blockedSnapshot.routes,
        initialState: blockedSnapshot,
      }),
    ).not.toThrow();
    const blockedAfterReroute = network.getState();
    expect(() => network.returnBlockedShipment('rerouted')).toThrow(/rerout|eligible/i);
    expect(network.getState()).toEqual(blockedAfterReroute);
    network.releaseBlock('river');
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'transit',
      commodity: 'grain',
      quantity: 2,
    });
    network.closeRoute('river');
    network.advanceTick();
    network.openRoute('river');
    expect(network.getState().shipments[0]?.arrivalTick).toBe(10);
    const snapshot = network.getState();
    const tampered = {
      ...snapshot,
      shipments: snapshot.shipments.map((shipment) => ({
        ...shipment,
        rerouteRemainingTicks: shipment.rerouteRemainingTicks! + 1,
        arrivalTick: shipment.arrivalTick + 1,
      })),
    };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes: snapshot.routes,
        initialState: tampered,
      }),
    ).toThrow(/reroute|shipment/i);
    const malformedPaid = {
      ...snapshot,
      shipments: snapshot.shipments.map((shipment) => ({
        ...shipment,
        buyerAccountId: undefined,
      })),
    };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes: snapshot.routes,
        initialState: malformedPaid,
      }),
    ).toThrow(/payment|provenance/i);
    const outOfOrder = {
      ...snapshot,
      shipments: snapshot.shipments.map((shipment) => ({
        ...shipment,
        rerouteBlockedAtTick: shipment.reroutedAtTick! + 1,
      })),
    };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes: snapshot.routes,
        initialState: outOfOrder,
      }),
    ).toThrow(/shipment|provenance/i);
    const restoredInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 3 },
        { ownerId: 'transit', commodity: 'grain', quantity: 2 },
      ],
    });
    const restored = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory: restoredInventory,
      routes: snapshot.routes,
      initialState: snapshot,
    });
    expect(restored.getState()).toEqual(snapshot);
    while (network.getState().tick < 10) network.advanceTick();
    while (restored.getState().tick < 10) restored.advanceTick();
    expect(restored.getState()).toEqual(network.getState());
    expect(restoredInventory.getState().balances).toEqual(inventory.getState().balances);
  });

  it('preserves active-time chronology after close, reopen, then block and reroute', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 5 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 2 },
    ];
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes,
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'chronology', routeId: 'road', commodity: 'grain', quantity: 1 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    network.advanceTick();
    network.closeRoute('road');
    network.advanceTick();
    network.openRoute('road');
    network.advanceTick();
    network.blockRoute('road');
    network.advanceTick();
    coordinator.reroute({ shipmentId: 'chronology', routeId: 'river', payment: 1 });
    const state = network.getState();
    const restoredInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'transit', commodity: 'grain', quantity: 1 }],
    });
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory: restoredInventory,
        routes,
        initialState: state,
      }),
    ).not.toThrow();
  });

  it('attacks a rerouted journey after original travel exceeds the alternative duration', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 5 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 2 },
    ];
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes,
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'late-attack', routeId: 'road', commodity: 'grain', quantity: 1 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    for (let i = 0; i < 4; i += 1) network.advanceTick();
    network.blockRoute('road');
    coordinator.reroute({ shipmentId: 'late-attack', routeId: 'river', payment: 1 });

    const returning = network.attackRoute('river');
    expect(returning.shipments[0]).toMatchObject({
      status: 'returning',
      attackTick: 4,
      returnDueTick: 8,
    });
    const corruptReturning = {
      ...returning,
      shipments: returning.shipments.map((shipment) => ({
        ...shipment,
        reroutedFromRouteId: 'missing-original-route',
      })),
    };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes,
        initialState: corruptReturning,
      }),
    ).toThrow(/invalid initial shipment state|provenance/i);
    const restoredInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'transit', commodity: 'grain', quantity: 1 }],
    });
    const restored = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory: restoredInventory,
      routes,
      initialState: returning,
    });
    while (restored.getState().tick < 8) restored.advanceTick();
    expect(restored.getState().shipments[0]?.status).toBe('returned');
    expect(restoredInventory.getState().balances).toContainEqual({
      ownerId: 'north',
      commodity: 'grain',
      quantity: 1,
    });
  });

  it('excludes alternative-route closure waiting from rerouted attack travel time', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 5 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 2 },
    ];
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes,
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'waiting-attack', routeId: 'road', commodity: 'grain', quantity: 1 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    network.advanceTick();
    network.blockRoute('road');
    coordinator.reroute({ shipmentId: 'waiting-attack', routeId: 'river', payment: 1 });
    network.closeRoute('river');
    network.advanceTick();
    network.advanceTick();
    network.advanceTick();
    network.openRoute('river');
    network.advanceTick();

    const attacked = network.attackRoute('river');
    expect(attacked.shipments[0]).toMatchObject({
      status: 'returning',
      attackTick: 5,
      returnDueTick: 7,
    });
    expect(attacked.shipments[0]?.rerouteOriginalDepartureTick).toBe(0);
    expect(attacked.shipments[0]?.rerouteBlockedAtTick).toBe(1);
  });

  it('attacks a rerouted journey using cumulative active outbound time', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 4 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 3 },
    ];
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes,
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: {
        shipmentId: 'attacked-reroute',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
      },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    network.advanceTick();
    network.blockRoute('road');
    coordinator.reroute({ shipmentId: 'attacked-reroute', routeId: 'river', payment: 1 });
    const snapshot = network.attackRoute('river');
    expect(snapshot.shipments[0]).toMatchObject({
      status: 'returning',
      attackTick: 1,
      returnDueTick: 2,
    });
    const restoredInventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'transit', commodity: 'grain', quantity: 1 }],
    });
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory: restoredInventory,
        routes,
        initialState: snapshot,
      }),
    ).not.toThrow();
  });

  it('does not accept forged paid provenance through public depart properties', () => {
    const { network, coordinator } = makeShipmentSystem();
    network.depart({
      shipmentId: 'forged',
      routeId: 'road',
      commodity: 'grain',
      quantity: 1,
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      originalPayment: 1,
      reroutedFromRouteId: 'road',
      reroutedAtTick: 0,
      rerouteRemainingTicks: 1,
    } as never);
    network.blockRoute('road');

    expect(network.getState().shipments[0]).not.toHaveProperty('buyerAccountId');
    expect(() =>
      coordinator.reroute({ shipmentId: 'forged', routeId: 'road', payment: 1 }),
    ).toThrow(/unpaid|paid provenance/i);
  });

  it('sanitizes runtime-only reroute fields supplied to paid departure', () => {
    const { network, coordinator } = makeShipmentSystem();
    coordinator.depart({
      shipment: {
        shipmentId: 'injected',
        routeId: 'road',
        commodity: 'grain',
        quantity: 1,
        reroutedFromRouteId: 'road',
        reroutedAtTick: 0,
        rerouteRemainingTicks: 1,
      } as never,
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    expect(network.getState().shipments[0]).not.toHaveProperty('reroutedFromRouteId');
  });

  it.each([
    ['unknown alternative route', 'missing', undefined],
    ['wrong alternative source', 'wrong-source', undefined],
    ['same alternative destination', 'same-destination', undefined],
    ['closed alternative route', 'river', 'closed'],
    ['blocked alternative route', 'river', 'blocked'],
    ['attacked alternative route', 'river', 'attacked'],
  ])('rejects %s without changing built-in participants', (_label, alternativeId, obstruction) => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 20 }],
    });
    const routes = [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 3 },
      { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 2 },
      { routeId: 'wrong-source', sourceCityId: 'south', destinationCityId: 'east', travelTicks: 2 },
      {
        routeId: 'same-destination',
        sourceCityId: 'north',
        destinationCityId: 'south',
        travelTicks: 2,
      },
    ];
    const network = createRouteNetwork({
      cityIds: ['north', 'south', 'east'],
      transitOwnerId: 'transit',
      inventory,
      routes,
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'matrix', routeId: 'road', commodity: 'grain', quantity: 1 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 2,
    });
    network.advanceTick();
    network.blockRoute('road');
    if (obstruction === 'closed') network.closeRoute('river');
    if (obstruction === 'blocked') network.blockRoute('river');
    if (obstruction === 'attacked') network.attackRoute('river');
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.reroute({ shipmentId: 'matrix', routeId: alternativeId, payment: 1 }),
    ).toThrow();
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('rejects reroute capacity, insufficient-funds, seller-overflow, repeated-choice and unsafe-tick failures without mutation', () => {
    const runFailure = (failure: string) => {
      const maximum = Number.MAX_SAFE_INTEGER;
      const unsafeTick = failure === 'unsafe tick' ? maximum - 10 : 0;
      const inventory = createInventory({
        owners: ['north', 'south', 'east', 'transit'],
        balances: [{ ownerId: 'north', commodity: 'grain', quantity: 3 }],
      });
      const money = createMoneyLedger({
        accounts: ['buyer-cash', 'seller-cash'],
        balances: [
          { accountId: 'buyer-cash', amount: failure === 'insufficient funds' ? 1 : 20 },
          {
            accountId: 'seller-cash',
            amount: failure === 'seller overflow' ? maximum - 2 : 0,
          },
        ],
      });
      const routes = [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 5 },
        {
          routeId: 'river',
          sourceCityId: 'north',
          destinationCityId: 'east',
          travelTicks: failure === 'unsafe tick' ? 10 : 2,
          ...(failure === 'capacity' ? { capacity: 1 } : {}),
        },
      ];
      const network = createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes,
        ...(unsafeTick > 0 ? { initialState: { tick: unsafeTick, routes, shipments: [] } } : {}),
      });
      const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
      if (failure === 'capacity') {
        coordinator.depart({
          shipment: { shipmentId: 'occupier', routeId: 'river', commodity: 'grain', quantity: 1 },
          buyerAccountId: 'buyer-cash',
          sellerAccountId: 'seller-cash',
          payment: 1,
        });
      }
      coordinator.depart({
        shipment: { shipmentId: 'matrix', routeId: 'road', commodity: 'grain', quantity: 1 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: failure === 'seller overflow' ? 2 : 1,
      });
      const ticks = failure === 'unsafe tick' ? 4 : 1;
      for (let i = 0; i < ticks; i += 1) network.advanceTick();
      network.blockRoute('road');
      if (failure === 'unsafe tick') {
        // The current tick and remaining original time leave no safe room for the alternative.
      }
      if (failure === 'repeated choice')
        coordinator.reroute({ shipmentId: 'matrix', routeId: 'river', payment: 1 });
      const before = {
        inventory: inventory.getState(),
        money: money.getState(),
        network: network.getState(),
      };
      const expectFailure = () =>
        coordinator.reroute({ shipmentId: 'matrix', routeId: 'river', payment: 1 });
      try {
        expect(expectFailure).toThrow();
      } catch {
        throw new Error(`expected ${failure} reroute rejection`);
      }
      expect(inventory.getState()).toEqual(before.inventory);
      expect(money.getState()).toEqual(before.money);
      expect(network.getState()).toEqual(before.network);
    };

    for (const failure of [
      'capacity',
      'insufficient funds',
      'seller overflow',
      'repeated choice',
      'unsafe tick',
    ])
      runFailure(failure);
  });

  it('rejects rerouting an unpaid held shipment without mutation', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    network.depart({ shipmentId: 'unpaid', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.blockRoute('road');
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };
    expect(() =>
      coordinator.reroute({ shipmentId: 'unpaid', routeId: 'road', payment: 5 }),
    ).toThrow(/unpaid|paid provenance/i);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('keeps the settled fee when an attacked paid shipment returns to its source', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    coordinator.depart({
      shipment: { shipmentId: 'paid-return', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 10,
    });
    const settled = money.getState();
    network.advanceTick();
    network.attackRoute('road');
    expect(network.getState().shipments[0]?.status).toBe('returning');
    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'blocked', routeId: 'road', commodity: 'grain', quantity: 1 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 5,
      }),
    ).toThrow(/attack/i);
    expect(money.getState()).toEqual(settled);
    network.advanceTick();
    expect(network.getState().shipments[0]?.status).toBe('returned');
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
    ]);
    expect(money.getState()).toEqual(settled);
  });

  it('keeps the paid fee when a blocked paid shipment is returned', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    coordinator.depart({
      shipment: { shipmentId: 'blocked-return', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 10,
    });
    const settled = money.getState();
    network.advanceTick();
    network.blockRoute('road');
    network.returnBlockedShipment('blocked-return');
    network.releaseBlock('road');
    network.advanceTick();
    expect(network.getState().shipments[0]?.status).toBe('returned');
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
    ]);
    expect(money.getState()).toEqual(settled);
  });

  it('rejects paid departures on a blocked route without settling money or moving goods', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    network.blockRoute('road');
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };
    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'blocked-load', routeId: 'road', commodity: 'grain', quantity: 1 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 10,
      }),
    ).toThrow(/block/i);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('rejects paid departures on a closed route without settling money or moving goods', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    network.closeRoute('road');
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };
    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'closed-load', routeId: 'road', commodity: 'grain', quantity: 1 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 10,
      }),
    ).toThrow(/closed/i);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('atomically departs goods and settles the caller-supplied payment', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();

    const receipt = coordinator.depart({
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 17,
    });

    expect(receipt.payment).toBe(17);
    expect(network.getState().shipments).toMatchObject([
      { shipmentId: 'load-1', status: 'in-transit', departureTick: 0, arrivalTick: 2 },
    ]);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 3 },
      { ownerId: 'transit', commodity: 'grain', quantity: 2 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
  });

  it('rejects paid departures over route capacity without side effects', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
    });
    const money = createMoneyLedger({
      accounts: ['buyer-cash', 'seller-cash'],
      balances: [{ accountId: 'buyer-cash', amount: 50 }],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        {
          routeId: 'road',
          sourceCityId: 'north',
          destinationCityId: 'south',
          travelTicks: 2,
          capacity: 2,
        },
      ],
    });
    const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
    coordinator.depart({
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 10,
    });
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-2', routeId: 'road', commodity: 'grain', quantity: 1 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 10,
      }),
    ).toThrow(/capacity/);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('leaves inventory, money, and shipment state unchanged when payment preparation fails', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 51,
      }),
    ).toThrow(/funds/);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('does not mutate earlier participants when shipment preparation fails', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'missing', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 17,
      }),
    ).toThrow(/route/);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('allows ordinary route networks with custom inventory but rejects them for paid coordination', () => {
    const inventory = createInventory({ owners: ['north', 'south', 'transit'] });
    const foreignInventory = {
      hasOwner: inventory.hasOwner.bind(inventory),
      getState: inventory.getState.bind(inventory),
      transfer: inventory.transfer.bind(inventory),
      consume: inventory.consume.bind(inventory),
      produce: inventory.produce.bind(inventory),
    };
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory: foreignInventory,
    });
    const money = createMoneyLedger({ accounts: ['buyer', 'seller'] });

    expect(() =>
      createPaidShipmentCoordinator({ inventory: foreignInventory, money, network }),
    ).toThrow(/built-in coordinator participants/i);
  });

  it('snapshots coordinator references before participant lookup and identity checks', () => {
    const { inventory, money, network } = makeShipmentSystem();
    const unrelatedInventory = createInventory({ owners: ['north', 'south', 'transit'] });
    let inventoryReads = 0;
    const input = {
      get inventory() {
        inventoryReads += 1;
        return inventoryReads === 1 ? inventory : unrelatedInventory;
      },
      money,
      network,
    };

    expect(() => createPaidShipmentCoordinator(input)).not.toThrow();
    expect(inventoryReads).toBe(1);
  });

  it('rejects a network coordinated with a different inventory instance', () => {
    const { money, network } = makeShipmentSystem();
    const unrelatedInventory = createInventory({ owners: ['north', 'south', 'transit'] });

    expect(() =>
      createPaidShipmentCoordinator({ inventory: unrelatedInventory, money, network }),
    ).toThrow(/same inventory|bound inventory/i);
    expect(unrelatedInventory.getState().balances).toEqual([]);
  });

  it('snapshots all input getters before preparing participant state', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    let buyerReads = 0;
    const paidShipment = {
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain' as const, quantity: 2 },
      get buyerAccountId() {
        buyerReads += 1;
        inventory.transfer('north', 'south', 'grain', 1);
        return 'buyer-cash';
      },
      sellerAccountId: 'seller-cash',
      payment: 17,
    };

    const receipt = coordinator.depart(paidShipment);

    expect(buyerReads).toBe(1);
    expect(receipt.payment).toBe(17);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 2 },
      { ownerId: 'south', commodity: 'grain', quantity: 1 },
      { ownerId: 'transit', commodity: 'grain', quantity: 2 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
    expect(network.getState().shipments).toHaveLength(1);
  });

  it('uses one payment snapshot for settlement and receipt', () => {
    const { money, coordinator } = makeShipmentSystem();
    let paymentReads = 0;
    const input = {
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain' as const, quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      get payment() {
        paymentReads += 1;
        return paymentReads === 1 ? 17 : 19;
      },
    };

    const receipt = coordinator.depart(input);

    expect(paymentReads).toBe(1);
    expect(receipt.payment).toBe(17);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
  });

  it('does not trust replaceable public route state for the shipment source', () => {
    const { inventory, network, coordinator } = makeShipmentSystem();
    network.getState = () => ({
      tick: 0,
      routes: [
        { routeId: 'road', sourceCityId: 'south', destinationCityId: 'north', travelTicks: 2 },
      ],
      shipments: [],
    });

    coordinator.depart({
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 17,
    });

    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'north',
      commodity: 'grain',
      quantity: 3,
    });
    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'transit',
      commodity: 'grain',
      quantity: 2,
    });
  });

  it('rejects a shipment paid to the same account without mutating state', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'buyer-cash',
        payment: 17,
      }),
    ).toThrow(/distinct|same account/i);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('rejects foreign ledgers whose atomic commit capability cannot be verified', () => {
    const { inventory, money, network } = makeShipmentSystem();
    const foreignMoney = {
      getState: money.getState,
      transfer: money.transfer,
    };

    expect(() =>
      createPaidShipmentCoordinator({ inventory, money: foreignMoney, network }),
    ).toThrow(/atomic|built-in|coordinator/i);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 50 },
      { accountId: 'seller-cash', amount: 0 },
    ]);
  });
});
