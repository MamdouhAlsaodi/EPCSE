import { describe, expect, it } from 'vitest';
import { createInventory, createRouteNetwork } from '@epcse/simulation-core';

describe('route shipments', () => {
  it('requires every city and the transit custodian to be inventory owners', () => {
    const inventory = createInventory({ owners: ['north', 'transit'] });

    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south'],
        transitOwnerId: 'transit',
        inventory,
        routes: [],
      }),
    ).toThrow(/south/);
    expect(() =>
      createRouteNetwork({
        cityIds: ['north'],
        transitOwnerId: 'missing',
        inventory,
        routes: [],
      }),
    ).toThrow(/transit/);
  });

  it('preflights all due destination capacity before changing inventory or tick', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 2 },
        { ownerId: 'south', commodity: 'grain', quantity: Number.MAX_SAFE_INTEGER - 1 },
      ],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 1 },
      ],
    });
    network.depart({ shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.depart({ shipmentId: 'load-2', routeId: 'road', commodity: 'grain', quantity: 1 });
    const beforeInventory = inventory.getState();
    const beforeNetwork = network.getState();

    expect(() => network.advanceTick()).toThrow(/exceed/);
    expect(inventory.getState()).toEqual(beforeInventory);
    expect(network.getState()).toEqual(beforeNetwork);
  });

  it('returns defensive route and shipment snapshots', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 1 },
      ],
    });
    network.depart({ shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 1 });
    const snapshot = network.getState() as unknown as {
      routes: { routeId: string }[];
      shipments: { shipmentId: string; status: string }[];
    };
    snapshot.routes[0]!.routeId = 'changed';
    snapshot.shipments[0]!.shipmentId = 'changed';
    snapshot.shipments[0]!.status = 'arrived';
    snapshot.routes.pop();
    expect(network.getState().routes).toHaveLength(1);
    expect(network.getState().routes[0]!.routeId).toBe('road');
    expect(network.getState().shipments).toMatchObject([
      { shipmentId: 'load-1', status: 'in-transit' },
    ]);
  });

  it('does not allow a city owner to double as transit custody', () => {
    const inventory = createInventory({ owners: ['north', 'south'] });

    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south'],
        transitOwnerId: 'north',
        inventory,
        routes: [],
      }),
    ).toThrow(/transit/);
  });

  it('rejects invalid fixed route declarations', () => {
    const inventory = createInventory({ owners: ['north', 'south', 'transit'] });
    const base = {
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
    };
    const validRoute = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 2,
    };

    for (const route of [
      { ...validRoute, sourceCityId: 'missing' },
      { ...validRoute, destinationCityId: 'north' },
      { ...validRoute, travelTicks: 0 },
      { ...validRoute, travelTicks: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => createRouteNetwork({ ...base, routes: [route] })).toThrow();
    }
  });

  it('shares bounded capacity across in-transit shipments and releases it on arrival', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 6 }],
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
          capacity: 5,
        },
      ],
    });

    network.depart({ shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 3 });
    network.depart({ shipmentId: 'load-2', routeId: 'road', commodity: 'grain', quantity: 2 });
    const beforeInventory = inventory.getState();
    const beforeNetwork = network.getState();
    expect(() =>
      network.depart({ shipmentId: 'load-3', routeId: 'road', commodity: 'grain', quantity: 1 }),
    ).toThrow(/capacity/);
    expect(inventory.getState()).toEqual(beforeInventory);
    expect(network.getState()).toEqual(beforeNetwork);

    network.advanceTick();
    network.advanceTick();
    network.depart({ shipmentId: 'load-3', routeId: 'road', commodity: 'grain', quantity: 1 });
    expect(network.getState().shipments).toMatchObject([
      { shipmentId: 'load-1', status: 'arrived' },
      { shipmentId: 'load-2', status: 'arrived' },
      { shipmentId: 'load-3', status: 'in-transit' },
    ]);
  });

  it('shares capacity across commodities and rejects over-capacity departures without mutation', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 3 },
        { ownerId: 'north', commodity: 'tools', quantity: 3 },
      ],
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
          capacity: 5,
        },
      ],
    });

    network.depart({ shipmentId: 'grain-load', routeId: 'road', commodity: 'grain', quantity: 3 });
    network.depart({ shipmentId: 'tools-load', routeId: 'road', commodity: 'tools', quantity: 2 });
    const beforeInventory = inventory.getState();
    const beforeNetwork = network.getState();

    expect(() =>
      network.depart({
        shipmentId: 'extra-tools',
        routeId: 'road',
        commodity: 'tools',
        quantity: 1,
      }),
    ).toThrow(/capacity/);
    expect(inventory.getState()).toEqual(beforeInventory);
    expect(network.getState()).toEqual(beforeNetwork);
  });

  it('leaves routes without capacity unlimited', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 6 }],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 2 },
      ],
    });

    network.depart({ shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 4 });
    network.depart({ shipmentId: 'load-2', routeId: 'road', commodity: 'grain', quantity: 2 });
    expect(network.getState().shipments).toHaveLength(2);
  });

  it('rejects invalid route capacities', () => {
    const inventory = createInventory({ owners: ['north', 'south', 'transit'] });
    const base = {
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
    };
    const route = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 1,
    };
    for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createRouteNetwork({ ...base, routes: [{ ...route, capacity }] })).toThrow();
    }
  });

  it('moves goods into transit at departure and delivers them on the due tick', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 8 }],
    });
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 2 },
      ],
    });

    network.depart({ shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 3 });
    expect(network.getState()).toMatchObject({
      tick: 0,
      shipments: [{ shipmentId: 'load-1', departureTick: 0, arrivalTick: 2, status: 'in-transit' }],
    });
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
      { ownerId: 'transit', commodity: 'grain', quantity: 3 },
    ]);

    network.advanceTick();
    expect(network.getState().tick).toBe(1);
    expect(inventory.getState().balances).toHaveLength(2);
    network.advanceTick();
    expect(network.getState()).toMatchObject({
      tick: 2,
      shipments: [{ shipmentId: 'load-1', status: 'arrived' }],
    });
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
      { ownerId: 'south', commodity: 'grain', quantity: 3 },
    ]);
  });
});
