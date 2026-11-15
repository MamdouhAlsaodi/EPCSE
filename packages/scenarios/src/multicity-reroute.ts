import {
  createInventory,
  createMoneyLedger,
  createPaidShipmentCoordinator,
  createRouteNetwork,
  createWorld,
  type Commodity,
} from '@epcse/simulation-core';

export interface MultiCityRerouteReport {
  readonly title: string;
  readonly disclaimer: string;
  readonly cities: readonly string[];
  readonly routes: readonly string[];
  readonly payments: { readonly initial: number; readonly extra: number; readonly total: number };
  readonly balances: { readonly buyer: number; readonly carrier: number };
  readonly destinationInventory: { readonly south: number; readonly east: number };
  readonly observations: {
    readonly waiting: {
      readonly tick: number;
      readonly status: 'in-transit';
      readonly routeId: string;
      readonly cargoInTransit: number;
      readonly east: number;
      readonly south: number;
      readonly extraPayment: number;
    };
    readonly beforeArrival: {
      readonly tick: number;
      readonly status: 'in-transit';
      readonly cargoInTransit: number;
      readonly east: number;
      readonly south: number;
    };
  };
  readonly shipment: {
    readonly shipmentId: string;
    readonly routeId: string;
    readonly status: 'arrived';
    readonly departureTick: number;
    readonly arrivalTick: number;
    readonly choiceTick: number;
    readonly originalDestinationCityId: string;
    readonly deliveredCityId: string;
    readonly commodity: Commodity;
    readonly quantity: number;
  };
  readonly conservation: {
    readonly moneyBefore: number;
    readonly moneyAfter: number;
    readonly cargoBefore: number;
    readonly cargoAfter: number;
  };
}

/** A deterministic, synthetic example of a paid shipment choosing an alternate city. */
export function runMultiCityRerouteDemo(): MultiCityRerouteReport {
  const inventory = createInventory({
    owners: ['north', 'south', 'east', 'transit'],
    balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
  });
  const money = createMoneyLedger({
    accounts: ['buyer', 'carrier'],
    balances: [{ accountId: 'buyer', amount: 100 }],
  });
  const network = createRouteNetwork({
    cityIds: ['north', 'south', 'east'],
    transitOwnerId: 'transit',
    inventory,
    routes: [
      {
        routeId: 'north-south-road',
        sourceCityId: 'north',
        destinationCityId: 'south',
        travelTicks: 4,
        capacity: 2,
      },
      {
        routeId: 'north-east-river',
        sourceCityId: 'north',
        destinationCityId: 'east',
        travelTicks: 2,
        capacity: 2,
      },
    ],
  });
  const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
  coordinator.depart({
    shipment: {
      shipmentId: 'grain-reroute-demo',
      routeId: 'north-south-road',
      commodity: 'grain',
      quantity: 2,
    },
    buyerAccountId: 'buyer',
    sellerAccountId: 'carrier',
    payment: 10,
  });
  const world = createWorld('synthetic-multicity-reroute-demo');
  world.registerTickSystem('route-advancement', () => network.advanceTick());
  world.step();
  network.blockRoute('north-south-road');
  world.run(2);
  const choiceTick = world.getState().tick;
  const amount = (ownerId: string): number =>
    inventory
      .getState()
      .balances.find((balance) => balance.ownerId === ownerId && balance.commodity === 'grain')
      ?.quantity ?? 0;
  const balance = (accountId: string): number =>
    money.getState().balances.find(({ accountId: id }) => id === accountId)!.amount;
  const shipmentAtChoice = network
    .getState()
    .shipments.find(({ shipmentId }) => shipmentId === 'grain-reroute-demo');
  if (!shipmentAtChoice || shipmentAtChoice.status !== 'in-transit')
    throw new Error('reroute demonstration shipment was not waiting in transit');
  const waiting = {
    tick: choiceTick,
    status: shipmentAtChoice.status,
    routeId: shipmentAtChoice.routeId,
    cargoInTransit: amount('transit'),
    east: amount('east'),
    south: amount('south'),
    extraPayment: balance('carrier') - 10,
  } as const;
  coordinator.reroute({
    shipmentId: 'grain-reroute-demo',
    routeId: 'north-east-river',
    payment: 7,
  });
  world.run(4);
  const shipmentBeforeArrival = network
    .getState()
    .shipments.find(({ shipmentId }) => shipmentId === 'grain-reroute-demo');
  if (!shipmentBeforeArrival || shipmentBeforeArrival.status !== 'in-transit')
    throw new Error('rerouted shipment arrived before its scheduled arrival');
  const beforeArrival = {
    tick: world.getState().tick,
    status: shipmentBeforeArrival.status,
    cargoInTransit: amount('transit'),
    east: amount('east'),
    south: amount('south'),
  } as const;
  world.step();

  const shipment = network
    .getState()
    .shipments.find(({ shipmentId }) => shipmentId === 'grain-reroute-demo');
  if (!shipment || shipment.status !== 'arrived')
    throw new Error('reroute demonstration did not arrive');
  const balances = { buyer: balance('buyer'), carrier: balance('carrier') };
  const destinationInventory = { south: amount('south'), east: amount('east') };
  return {
    title: 'Three-city paid-reroute demonstration',
    disclaimer:
      'Synthetic scripted route evidence only; not a complete S0, T07/T08, M1, or economic simulation.',
    cities: ['north', 'south', 'east'],
    routes: ['north-south-road', 'north-east-river'],
    payments: { initial: 10, extra: 7, total: 17 },
    balances,
    destinationInventory,
    observations: { waiting, beforeArrival },
    shipment: {
      shipmentId: shipment.shipmentId,
      routeId: shipment.routeId,
      status: 'arrived',
      departureTick: shipment.rerouteOriginalDepartureTick ?? shipment.departureTick,
      arrivalTick: shipment.arrivalTick,
      choiceTick,
      originalDestinationCityId: 'south',
      deliveredCityId: 'east',
      commodity: shipment.commodity,
      quantity: shipment.quantity,
    },
    conservation: {
      moneyBefore: 100,
      moneyAfter: balances.buyer + balances.carrier,
      cargoBefore: 5,
      cargoAfter: ['north', 'south', 'east', 'transit'].reduce(
        (sum, ownerId) => sum + amount(ownerId),
        0,
      ),
    },
  };
}
