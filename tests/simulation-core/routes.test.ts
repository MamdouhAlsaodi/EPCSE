import { describe, expect, it } from 'vitest';
import { createInventory, createRouteNetwork } from '../../packages/simulation-core/src/index.js';

describe('route shipments', () => {
  const customInventory = (backing: ReturnType<typeof createInventory>) => ({
    hasOwner: backing.hasOwner.bind(backing),
    getState: backing.getState.bind(backing),
    transfer: backing.transfer.bind(backing),
    consume: backing.consume.bind(backing),
    produce: backing.produce.bind(backing),
  });

  it('pauses a closed route, blocks departures, and resumes the exact remaining journey', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'east', 'transit'],
      balances: [
        { ownerId: 'north', commodity: 'grain', quantity: 5 },
        { ownerId: 'north', commodity: 'wood', quantity: 1 },
      ],
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
          travelTicks: 3,
          capacity: 1,
        },
        { routeId: 'river', sourceCityId: 'north', destinationCityId: 'east', travelTicks: 1 },
      ],
    });
    network.depart({ shipmentId: 'paused', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.advanceTick();
    network.closeRoute('road');
    expect(network.advanceTick().shipments[0]).toMatchObject({
      status: 'in-transit',
      arrivalTick: 3,
    });
    expect(network.advanceTick().shipments[0]).toMatchObject({
      status: 'in-transit',
      arrivalTick: 3,
    });
    expect(() =>
      network.depart({ shipmentId: 'blocked', routeId: 'road', commodity: 'wood', quantity: 1 }),
    ).toThrow(/closed/i);
    network.depart({ shipmentId: 'other-route', routeId: 'river', commodity: 'wood', quantity: 1 });
    network.advanceTick();
    expect(
      network.getState().shipments.find(({ shipmentId }) => shipmentId === 'paused')?.status,
    ).toBe('in-transit');
    expect(
      inventory
        .getState()
        .balances.find(({ ownerId, commodity }) => ownerId === 'transit' && commodity === 'grain')
        ?.quantity,
    ).toBe(1);
    network.openRoute('road');
    expect(
      network.advanceTick().shipments.find(({ shipmentId }) => shipmentId === 'paused'),
    ).toMatchObject({ status: 'in-transit', arrivalTick: 6 });
    expect(
      network.advanceTick().shipments.find(({ shipmentId }) => shipmentId === 'paused')?.status,
    ).toBe('arrived');
  });

  it('restores a paused route with defensive snapshots and rejects malformed closure state', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const route = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 3,
    };
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [route],
    });
    network.depart({ shipmentId: 'paused', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.advanceTick();
    network.closeRoute('road');
    network.advanceTick();
    const state = network.getState();
    const external = network.getState();
    (external as unknown as { closedRouteIds: string[] }).closedRouteIds.push('fake');
    (external.shipments[0] as unknown as { pausedRemainingTicks: number }).pausedRemainingTicks =
      99;
    expect(network.getState()).toEqual(state);

    const restored = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [route],
      initialState: state,
    });
    restored.advanceTick();
    expect(restored.getState().shipments[0]).toMatchObject({
      status: 'in-transit',
      pausedRemainingTicks: 2,
    });
    restored.openRoute('road');
    expect(restored.advanceTick().shipments[0]?.status).toBe('in-transit');
    expect(restored.advanceTick().shipments[0]?.status).toBe('arrived');

    const malformed = { ...state, closedRouteIds: ['missing'] };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south'],
        transitOwnerId: 'transit',
        inventory,
        routes: [route],
        initialState: malformed,
      }),
    ).toThrow(/closed route/i);
    expect(network.getState()).toEqual(state);
  });

  it('requires every city and the transit custodian to be inventory owners', () => {
    const inventory = createInventory({ owners: ['north', 'transit'] });
    expect(() =>
      createRouteNetwork({ cityIds: ['north', 'south'], transitOwnerId: 'transit', inventory }),
    ).toThrow(/south/);
    expect(() =>
      createRouteNetwork({ cityIds: ['north'], transitOwnerId: 'missing', inventory }),
    ).toThrow(/transit/);
  });

  it('rejects a paused snapshot whose implied closure begins in the future', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'transit', commodity: 'grain', quantity: 1 }],
    });
    const route = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 3,
    };
    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south'],
        transitOwnerId: 'transit',
        inventory,
        routes: [route],
        initialState: {
          tick: 2,
          routes: [route],
          closedRouteIds: ['road'],
          shipments: [
            {
              shipmentId: 'load',
              routeId: 'road',
              commodity: 'grain',
              quantity: 1,
              departureTick: 0,
              arrivalTick: 100,
              status: 'in-transit',
              pausedRemainingTicks: 2,
            },
          ],
        },
      }),
    ).toThrow(/shipment/i);
  });

  it('restores a valid paused snapshot after multiple closure and reopening cycles', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 1 }],
    });
    const route = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 4,
    };
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [route],
    });
    network.depart({ shipmentId: 'load', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.advanceTick();
    network.closeRoute('road');
    network.advanceTick();
    network.openRoute('road');
    network.advanceTick();
    network.closeRoute('road');
    const state = network.getState();
    expect(state).toMatchObject({
      tick: 3,
      shipments: [{ arrivalTick: 5, pausedRemainingTicks: 2 }],
    });
    expect(
      createRouteNetwork({
        cityIds: ['north', 'south'],
        transitOwnerId: 'transit',
        inventory,
        routes: [route],
        initialState: state,
      }).getState(),
    ).toEqual(state);
  });

  it('rejects malformed initial shipment identifiers, statuses, and temporal state', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'transit', commodity: 'grain', quantity: 2 }],
    });
    const route = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 2,
    };
    const base = {
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [route],
      initialState: {
        tick: 1,
        routes: [route],
        shipments: [
          {
            shipmentId: 'load',
            routeId: 'road',
            commodity: 'grain' as const,
            quantity: 1,
            departureTick: 0,
            arrivalTick: 2,
            status: 'in-transit' as const,
          },
        ],
      },
    };
    expect(() =>
      createRouteNetwork({
        ...base,
        initialState: {
          ...base.initialState,
          shipments: [{ ...base.initialState.shipments[0]!, shipmentId: '' }],
        },
      }),
    ).toThrow();
    expect(() =>
      createRouteNetwork({
        ...base,
        initialState: {
          ...base.initialState,
          shipments: [base.initialState.shipments[0]!, base.initialState.shipments[0]!],
        },
      }),
    ).toThrow();
    expect(() =>
      createRouteNetwork({
        ...base,
        initialState: {
          ...base.initialState,
          shipments: [{ ...base.initialState.shipments[0]!, status: 'invalid' as 'in-transit' }],
        },
      }),
    ).toThrow();
    expect(() =>
      createRouteNetwork({
        ...base,
        initialState: {
          ...base.initialState,
          shipments: [{ ...base.initialState.shipments[0]!, arrivalTick: 3 }],
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate snapshot route IDs that omit a configured route', () => {
    const inventory = createInventory({ owners: ['north', 'south', 'east', 'transit'] });
    const first = {
      routeId: 'road',
      sourceCityId: 'north',
      destinationCityId: 'south',
      travelTicks: 1,
    };
    const second = {
      routeId: 'river',
      sourceCityId: 'north',
      destinationCityId: 'east',
      travelTicks: 2,
    };

    expect(() =>
      createRouteNetwork({
        cityIds: ['north', 'south', 'east'],
        transitOwnerId: 'transit',
        inventory,
        routes: [first, second],
        initialState: { tick: 0, routes: [first, first], shipments: [] },
      }),
    ).toThrow(/initial routes/i);
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

  it('delivers all due shipments atomically without calling replaceable transfer', () => {
    const inventory = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 4 }],
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
    inventory.transfer = () => {
      throw new Error('patched transfer must not run during delivery');
    };
    expect(network.advanceTick()).toMatchObject({
      tick: 1,
      shipments: [
        { shipmentId: 'load-1', status: 'arrived' },
        { shipmentId: 'load-2', status: 'arrived' },
      ],
    });
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 2 },
      { ownerId: 'south', commodity: 'grain', quantity: 2 },
    ]);
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

  it('preserves multiple due deliveries for custom Inventory without claiming rollback', () => {
    const backing = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const inventory = customInventory(backing);
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 1 },
      ],
    });
    network.depart({ shipmentId: 'custom-1', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.depart({ shipmentId: 'custom-2', routeId: 'road', commodity: 'grain', quantity: 1 });
    expect(network.advanceTick()).toMatchObject({
      tick: 1,
      shipments: [{ status: 'arrived' }, { status: 'arrived' }],
    });
    expect(backing.getState().balances).toEqual([
      { ownerId: 'south', commodity: 'grain', quantity: 2 },
    ]);
  });

  it('documents custom delivery mutation can be partial if a later transfer throws', () => {
    const backing = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const inventory = customInventory(backing);
    const originalTransfer = inventory.transfer;
    let calls = 0;
    inventory.transfer = (...args) => {
      calls += 1;
      if (calls === 4) throw new Error('custom transfer failure');
      return originalTransfer(...args);
    };
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 1 },
      ],
    });
    network.depart({ shipmentId: 'custom-1', routeId: 'road', commodity: 'grain', quantity: 1 });
    network.depart({ shipmentId: 'custom-2', routeId: 'road', commodity: 'grain', quantity: 1 });
    const beforeNetwork = network.getState();
    expect(() => network.advanceTick()).toThrow(/custom transfer failure/);
    expect(backing.getState().balances).toEqual([
      { ownerId: 'south', commodity: 'grain', quantity: 1 },
      { ownerId: 'transit', commodity: 'grain', quantity: 1 },
    ]);
    expect(network.getState()).toEqual(beforeNetwork);
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

  it('supports a wrapped custom inventory for ordinary single-shipment routes', () => {
    const backing = createInventory({
      owners: ['north', 'south', 'transit'],
      balances: [{ ownerId: 'north', commodity: 'grain', quantity: 2 }],
    });
    const inventory = customInventory(backing);
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory,
      routes: [
        { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 1 },
      ],
    });

    network.depart({ shipmentId: 'custom-1', routeId: 'road', commodity: 'grain', quantity: 1 });
    expect(backing.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 1 },
      { ownerId: 'transit', commodity: 'grain', quantity: 1 },
    ]);
    expect(network.advanceTick()).toMatchObject({ tick: 1, shipments: [{ status: 'arrived' }] });
    expect(backing.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 1 },
      { ownerId: 'south', commodity: 'grain', quantity: 1 },
    ]);
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
      shipments: [{ departureTick: 0, arrivalTick: 2, status: 'in-transit' }],
    });
    network.advanceTick();
    expect(network.getState().tick).toBe(1);
    network.advanceTick();
    expect(network.getState()).toMatchObject({ tick: 2, shipments: [{ status: 'arrived' }] });
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
      { ownerId: 'south', commodity: 'grain', quantity: 3 },
    ]);
  });
});
