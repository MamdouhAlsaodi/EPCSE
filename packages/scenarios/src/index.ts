import {
  createCityMarket,
  createConsumptionSystem,
  createInventory,
  createMoneyLedger,
  createPopulationLedger,
  createRecipeProducer,
  createRouteNetwork,
  createWorld,
  createWorldDomain,
  registerMarketClearing,
  type Commodity,
  type InventorySnapshot,
  type MoneySnapshot,
  type RouteNetworkSnapshot,
  type RecipeProducerSnapshot,
  type PopulationNeed,
} from '@epcse/simulation-core';
import { engineStatus } from '@epcse/simulation-core';

export const scenarioStatus = {
  implemented: true,
  kind: 'limited-scripted-demonstration',
  core: '@epcse/simulation-core',
  coreImplemented: engineStatus.implemented,
} as const;

export interface TwoCityReport {
  readonly title: string;
  readonly disclaimer: string;
  readonly tick: number;
  readonly cities: readonly { id: string; population: number }[];
  readonly goods: readonly Commodity[];
  readonly establishments: readonly string[];
  readonly production: {
    cityId: string;
    establishmentId: string;
    commodity: Commodity;
    quantity: number;
    batches: number;
    recipe: string;
    status: 'running' | 'stopped';
    stoppedReason?: 'missing-inputs';
  };
  readonly firstTickPrice: {
    commodity: Commodity;
    supplied: number;
    demanded: number;
    unitPrice: number;
  };
  readonly trade: {
    cityId: string;
    commodity: Commodity;
    quantity: number;
    total: number;
    balancesAfter: { buyer: number; seller: number };
  };
  readonly recurring: {
    harbor: { demanded: number; traded: number; consumed: number; unmet: number };
    inland: { demanded: number; traded: number; consumed: number; unmet: number };
  };
  readonly shipment: {
    shipmentId: string;
    commodity: Commodity;
    quantity: number;
    departureTick: number;
    arrivalTick: number;
    status: 'arrived';
  };
  readonly route: { routeId: string; travelTicks: number };
  readonly finalInventory: InventorySnapshot['balances'];
  readonly finalMoney: {
    buyerAccount: number;
    sellerAccount: number;
    inlandBuyerAccount: number;
    inlandSellerAccount: number;
  };
  readonly conservation: {
    grainBefore: number;
    grainConsumed: number;
    grainAfter: number;
    moneyBefore: number;
    moneyAfter: number;
  };
}

/**
 * Explicit snapshot contract (not automatic change detection): maintainers must bump this when
 * future-affecting two-city scenario rules or configuration change.
 */
export const TWO_CITY_SCENARIO_VERSION = 1 as const;

export interface TwoCitySimulationSnapshot {
  readonly version: 1;
  readonly scenarioVersion: typeof TWO_CITY_SCENARIO_VERSION;
  readonly tick: number;
  readonly inventory: InventorySnapshot;
  readonly money: MoneySnapshot;
  readonly routes: RouteNetworkSnapshot;
  readonly producer: RecipeProducerSnapshot;
  readonly consumption: {
    readonly unmetNeeds: readonly PopulationNeed[];
    readonly cumulativeUnmetNeeds: readonly PopulationNeed[];
  };
  readonly counters: {
    readonly harbor: {
      readonly traded: number;
      readonly consumed: number;
      readonly unmet: number;
      readonly total: number;
    };
    readonly inland: { readonly traded: number; readonly unmet: number };
    readonly firstTickUnitPrice: number | null;
  };
}

export interface TwoCitySimulation {
  step(): TwoCitySimulationSnapshot;
  run(ticks: number): TwoCitySimulationSnapshot;
  snapshot(): TwoCitySimulationSnapshot;
  report(): TwoCityReport;
}

const configuration = {
  ownerIds: ['harbor', 'inland', 'harbor-granary', 'inland-workshop', 'transit'],
  accountIds: [
    'harbor-households',
    'harbor-granary-account',
    'inland-households',
    'inland-workshop-account',
  ],
  route: {
    routeId: 'harbor-inland',
    sourceCityId: 'harbor',
    destinationCityId: 'inland',
    travelTicks: 3,
  },
};
const clone = <T>(value: T): T => structuredClone(value);
const safeCounter = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function validateSnapshot(value: TwoCitySimulationSnapshot): void {
  if (!value || typeof value !== 'object' || value.version !== 1)
    throw new RangeError('unsupported or invalid snapshot schema version');
  if (value.scenarioVersion !== TWO_CITY_SCENARIO_VERSION)
    throw new RangeError('snapshot scenario rules/config version does not match');
  if (!safeCounter(value.tick) || value.routes?.tick !== value.tick)
    throw new RangeError('snapshot ticks are inconsistent');
  if (!Array.isArray(value.inventory?.balances) || !Array.isArray(value.money?.balances))
    throw new RangeError('invalid ledger snapshot');
  const owners = new Set(configuration.ownerIds);
  const inventoryKeys = new Set<string>();
  for (const b of value.inventory.balances) {
    if (
      !owners.has(b.ownerId) ||
      !['grain', 'wood', 'tools'].includes(b.commodity) ||
      !safeCounter(b.quantity) ||
      b.quantity === 0
    )
      throw new RangeError('invalid inventory balance');
    const key = `${b.ownerId}\0${b.commodity}`;
    if (inventoryKeys.has(key)) throw new RangeError('duplicate inventory balance');
    inventoryKeys.add(key);
  }
  const accounts = new Set(configuration.accountIds);
  if (value.money.balances.length !== accounts.size) throw new RangeError('invalid money accounts');
  for (const b of value.money.balances)
    if (!accounts.delete(b.accountId) || !safeCounter(b.amount))
      throw new RangeError('invalid money balance');
  if (accounts.size) throw new RangeError('missing money account');
  const shipments = value.routes.shipments;
  if (
    !Array.isArray(shipments) ||
    !Array.isArray(value.routes.routes) ||
    value.routes.routes.length !== 1 ||
    !shipments.some((s) => s.shipmentId === 'grain-001')
  )
    throw new RangeError('invalid route state');
  const route = value.routes.routes[0]!;
  if (
    route.routeId !== configuration.route.routeId ||
    route.sourceCityId !== configuration.route.sourceCityId ||
    route.destinationCityId !== configuration.route.destinationCityId ||
    route.travelTicks !== configuration.route.travelTicks ||
    route.capacity !== undefined
  )
    throw new RangeError('snapshot route configuration does not match scenario');
  const ids = new Set<string>();
  const transit = new Map<string, number>();
  for (const s of shipments) {
    if (
      ids.has(s.shipmentId) ||
      s.shipmentId.length === 0 ||
      s.routeId !== configuration.route.routeId ||
      s.commodity !== 'grain' ||
      !safeCounter(s.quantity) ||
      s.quantity === 0 ||
      !safeCounter(s.departureTick) ||
      !safeCounter(s.arrivalTick) ||
      s.arrivalTick !== s.departureTick + 3 ||
      s.departureTick > value.tick ||
      !['in-transit', 'arrived'].includes(s.status) ||
      (s.status === 'in-transit' ? s.arrivalTick <= value.tick : s.arrivalTick > value.tick)
    )
      throw new RangeError('invalid shipment state');
    ids.add(s.shipmentId);
    if (s.status === 'in-transit') transit.set('grain', (transit.get('grain') ?? 0) + s.quantity);
  }
  if (
    !shipments.some(
      (s) => s.shipmentId === 'grain-001' && s.quantity === 3 && s.departureTick === 0,
    )
  )
    throw new RangeError('missing scenario shipment');
  if (shipments.length !== 1) throw new RangeError('unexpected scenario shipment');
  const transitQuantity =
    value.inventory.balances.find((b) => b.ownerId === 'transit' && b.commodity === 'grain')
      ?.quantity ?? 0;
  if (transitQuantity !== (transit.get('grain') ?? 0))
    throw new RangeError('transit inventory does not match in-transit shipments');
  if (
    !safeCounter(value.producer.batchesProduced) ||
    !['running', 'stopped'].includes(value.producer.status) ||
    (value.producer.status === 'running' && value.producer.stoppedReason !== undefined) ||
    (value.producer.status === 'stopped' && value.producer.stoppedReason !== 'missing-inputs') ||
    value.producer.batchesProduced > 1 ||
    (value.producer.status === 'stopped' && value.tick < 2)
  )
    throw new RangeError('invalid producer state');
  for (const field of ['harbor', 'inland'] as const)
    for (const n of Object.values(value.counters[field]))
      if (!safeCounter(n)) throw new RangeError('invalid report counter');
  if (
    value.counters.harbor.traded !== value.counters.harbor.consumed ||
    value.counters.harbor.total > Number.MAX_SAFE_INTEGER ||
    value.counters.harbor.traded + value.counters.harbor.unmet !== value.tick * 2 ||
    value.counters.inland.traded + value.counters.inland.unmet !== value.tick ||
    value.counters.inland.traded !== Math.min(value.tick, 2)
  )
    throw new RangeError('inconsistent report counters');
  if (
    value.counters.harbor.consumed > 7 ||
    value.counters.inland.unmet !== Math.max(0, value.tick - 2)
  )
    throw new RangeError('report counters do not match scenario state');
  const expectedInventory = [
    { ownerId: 'harbor-granary', commodity: 'grain', quantity: 7 - value.counters.harbor.consumed },
    { ownerId: 'inland', commodity: 'grain', quantity: value.tick >= 3 ? 3 : 0 },
    { ownerId: 'transit', commodity: 'grain', quantity: value.tick < 3 ? 3 : 0 },
    {
      ownerId: 'inland-workshop',
      commodity: 'wood',
      quantity: 4 - value.producer.batchesProduced * 2 - value.counters.inland.traded,
    },
    {
      ownerId: 'inland-workshop',
      commodity: 'tools',
      quantity: value.producer.batchesProduced * 2,
    },
  ].filter((balance) => balance.quantity > 0);
  const inventoryKey = (balance: { ownerId: string; commodity: string }) =>
    `${balance.ownerId}\\0${balance.commodity}`;
  const actualInventory = new Map(
    value.inventory.balances.map((b) => [inventoryKey(b), b.quantity]),
  );
  const expectedInventoryMap = new Map(expectedInventory.map((b) => [inventoryKey(b), b.quantity]));
  if (
    actualInventory.size !== expectedInventoryMap.size ||
    [...expectedInventoryMap].some(([key, quantity]) => actualInventory.get(key) !== quantity)
  )
    throw new RangeError('inventory positions do not match scenario production and trade state');
  const expectedMoney = new Map([
    ['harbor-households', 100 - value.counters.harbor.total],
    ['harbor-granary-account', value.counters.harbor.total],
    ['inland-households', 60 - value.counters.inland.traded * 2],
    ['inland-workshop-account', value.counters.inland.traded * 2],
  ]);
  if (
    [...expectedMoney].some(
      ([accountId, amount]) =>
        value.money.balances.find((balance) => balance.accountId === accountId)?.amount !== amount,
    )
  )
    throw new RangeError('money balances do not match recorded sales and opening budgets');
  let expectedGrainStock = 7;
  let expectedHarborSales = 0;
  let expectedHarborTotal = 0;
  let expectedFirstPrice: number | null = null;
  for (let tick = 0; tick < Math.min(value.tick, 4); tick += 1) {
    const price = Math.min(20, Math.max(1, Math.floor((4 * 3) / (expectedGrainStock + 1))));
    if (expectedFirstPrice === null) expectedFirstPrice = price;
    const quantity = Math.min(2, expectedGrainStock, Math.floor(100 / price));
    expectedGrainStock -= quantity;
    expectedHarborSales += quantity;
    expectedHarborTotal += quantity * price;
  }
  if (
    value.counters.harbor.traded !== expectedHarborSales ||
    value.counters.harbor.total !== expectedHarborTotal ||
    value.counters.firstTickUnitPrice !== expectedFirstPrice
  )
    throw new RangeError('sales counters do not match scenario supply and pricing');
  if (
    value.counters.firstTickUnitPrice !== null &&
    (!safeCounter(value.counters.firstTickUnitPrice) || value.counters.firstTickUnitPrice === 0)
  )
    throw new RangeError('invalid first tick price');
  if ((value.tick === 0) !== (value.counters.firstTickUnitPrice === null))
    throw new RangeError('inconsistent first tick price');
  const need = (items: readonly PopulationNeed[], expectedTotal?: number): void => {
    if (!Array.isArray(items)) throw new RangeError('invalid consumption state');
    const seen = new Set<string>();
    let total = 0;
    for (const n of items) {
      if (
        !['grain', 'wood', 'tools'].includes(n.commodity) ||
        seen.has(n.commodity) ||
        !safeCounter(n.quantity) ||
        n.quantity === 0
      )
        throw new RangeError('invalid consumption need');
      seen.add(n.commodity);
      total += n.quantity;
    }
    if (!Number.isSafeInteger(total) || (expectedTotal !== undefined && total > expectedTotal))
      throw new RangeError('inconsistent consumption state');
  };
  need(value.consumption.unmetNeeds);
  need(value.consumption.cumulativeUnmetNeeds, value.tick * 1);
  if (
    value.consumption.unmetNeeds.some((n) => n.commodity !== 'wood') ||
    value.consumption.cumulativeUnmetNeeds.some((n) => n.commodity !== 'wood')
  )
    throw new RangeError('invalid consumption state');
  const currentUnmet = value.consumption.unmetNeeds.reduce((sum, n) => sum + n.quantity, 0);
  const cumulativeUnmet = value.consumption.cumulativeUnmetNeeds.reduce(
    (sum, n) => sum + n.quantity,
    0,
  );
  if (
    currentUnmet !== (value.tick === 0 || value.tick > 2 ? 1 : 0) ||
    cumulativeUnmet !== value.counters.inland.unmet
  )
    throw new RangeError('consumption state does not match report counters');
  if (
    value.producer.batchesProduced !== (value.tick > 0 ? 1 : 0) ||
    value.producer.status !== (value.tick >= 2 ? 'stopped' : 'running')
  )
    throw new RangeError('producer state does not match tick');
}

function build(initial?: TwoCitySimulationSnapshot): TwoCitySimulation {
  if (initial) validateSnapshot(initial);
  const seedInventory = initial?.inventory ?? {
    balances: [
      { ownerId: 'harbor-granary', commodity: 'grain', quantity: 10 },
      { ownerId: 'inland-workshop', commodity: 'wood', quantity: 4 },
    ],
  };
  const inventory = createInventory({
    owners: configuration.ownerIds,
    balances: seedInventory.balances,
  });
  const seedMoney = initial?.money ?? {
    balances: [
      { accountId: 'harbor-households', amount: 100 },
      { accountId: 'harbor-granary-account', amount: 0 },
      { accountId: 'inland-households', amount: 60 },
      { accountId: 'inland-workshop-account', amount: 0 },
    ],
  };
  const money = createMoneyLedger({
    accounts: configuration.accountIds,
    balances: seedMoney.balances,
  });
  const domain = createWorldDomain({
    kingdoms: [{ id: 'north' }, { id: 'south' }],
    cities: [
      { id: 'harbor', kingdomId: 'north' },
      { id: 'inland', kingdomId: 'south' },
    ],
    establishments: [
      { id: 'harbor-granary', cityId: 'harbor', ownerKingdomId: 'north' },
      { id: 'inland-workshop', cityId: 'inland', ownerKingdomId: 'south' },
    ],
  }).getState();
  const population = createPopulationLedger({
    cohorts: [
      {
        cohortId: 'harbor-households',
        cityId: 'harbor',
        population: 120,
        openingBudget: 100,
        needs: [{ commodity: 'grain', quantity: 2 }],
      },
      {
        cohortId: 'inland-households',
        cityId: 'inland',
        population: 80,
        openingBudget: 60,
        needs: [{ commodity: 'wood', quantity: 1 }],
      },
    ],
  }).getState();
  const world = createWorld('provisional-two-city-demo');
  if (initial?.tick) world.run(initial.tick);
  const harborMarket = createCityMarket({
    cityId: 'harbor',
    inventory,
    money,
    participants: [
      { ownerId: 'harbor', accountId: 'harbor-households' },
      { ownerId: 'harbor-granary', accountId: 'harbor-granary-account' },
    ],
  });
  const inlandMarket = createCityMarket({
    cityId: 'inland',
    inventory,
    money,
    participants: [
      { ownerId: 'inland', accountId: 'inland-households' },
      { ownerId: 'inland-workshop', accountId: 'inland-workshop-account' },
    ],
  });
  const routes = createRouteNetwork({
    cityIds: ['harbor', 'inland'],
    transitOwnerId: 'transit',
    inventory,
    routes: [configuration.route],
    ...(initial ? { initialState: initial.routes } : {}),
  });
  if (!initial) {
    inventory.transfer('harbor-granary', 'harbor', 'grain', 3);
    routes.depart({
      shipmentId: 'grain-001',
      routeId: 'harbor-inland',
      commodity: 'grain',
      quantity: 3,
    });
  }
  world.registerTickSystem('route-advancement', () => routes.advanceTick());
  const producer = createRecipeProducer(
    world,
    'inland-workshop',
    inventory,
    'inland-workshop',
    {
      inputs: [{ commodity: 'wood', quantity: 2 }],
      outputs: [{ commodity: 'tools', quantity: 2 }],
    },
    { ...(initial ? { initialState: initial.producer } : {}) },
  );
  const harbor: { traded: number; consumed: number; unmet: number; total: number } = initial
    ? { ...initial.counters.harbor }
    : { traded: 0, consumed: 0, unmet: 0, total: 0 };
  let firstTickUnitPrice: number | undefined = initial?.counters.firstTickUnitPrice ?? undefined;
  registerMarketClearing({
    world,
    cityId: 'harbor',
    commodity: 'grain',
    buyerId: 'harbor',
    buyerAccountId: 'harbor-households',
    sellerId: 'harbor-granary',
    desiredDemand: 2,
    basePrice: 4,
    maxPrice: 20,
    market: harborMarket,
    inventory,
    money,
    onTick: ({ tick, quantity, unmetDemand, price }) => {
      if (tick === 1) firstTickUnitPrice = price;
      harbor.traded += quantity;
      harbor.unmet += unmetDemand;
      harbor.total += quantity * price;
      if (quantity > 0) {
        inventory.consume('harbor', 'grain', quantity);
        harbor.consumed += quantity;
      }
    },
  });
  const inland: { traded: number; unmet: number } = initial
    ? { ...initial.counters.inland }
    : { traded: 0, unmet: 0 };
  const inlandConsumption = createConsumptionSystem({
    world,
    cohort: {
      cohortId: 'inland-households',
      cityId: 'inland',
      population: 80,
      openingBudget: 60,
      needs: [{ commodity: 'wood', quantity: 1 }],
    },
    buyer: { ownerId: 'inland', accountId: 'inland-households' },
    sellers: { wood: 'inland-workshop' },
    prices: { wood: 2 },
    market: inlandMarket,
    inventory,
    money,
    ...(initial ? { initialState: initial.consumption } : {}),
  });
  world.registerTickSystem('inland-consumption-reporting', () => {
    const unmet = inlandConsumption.getUnmetNeeds().reduce((sum, n) => sum + n.quantity, 0);
    inland.unmet += unmet;
    inland.traded += 1 - unmet;
  });
  const snapshot = (): TwoCitySimulationSnapshot =>
    clone({
      version: 1,
      scenarioVersion: TWO_CITY_SCENARIO_VERSION,
      tick: world.getState().tick,
      inventory: inventory.getState(),
      money: money.getState(),
      routes: routes.getState(),
      producer: producer.getState(),
      consumption: {
        unmetNeeds: inlandConsumption.getUnmetNeeds(),
        cumulativeUnmetNeeds: inlandConsumption.getCumulativeUnmetNeeds(),
      },
      counters: { harbor, inland, firstTickUnitPrice: firstTickUnitPrice ?? null },
    });
  const report = (): TwoCityReport => {
    const state = snapshot();
    const account = (id: string) => state.money.balances.find((b) => b.accountId === id)!.amount;
    const shipment = state.routes.shipments.find((s) => s.shipmentId === 'grain-001');
    if (!shipment || shipment.status !== 'arrived' || firstTickUnitPrice === undefined)
      throw new Error('scenario report is not complete');
    const grainAfter = state.inventory.balances
      .filter((b) => b.commodity === 'grain')
      .reduce((sum, b) => sum + b.quantity, 0);
    return {
      title: 'Two-city scripted demonstration',
      disclaimer:
        'Synthetic scripted actions with provisional recipes and pricing; not a complete S0 or economic simulation. Demand, prices, and production rules are illustrative.',
      tick: state.tick,
      cities: population.cohorts.map(({ cityId, population: count }) => ({
        id: cityId,
        population: count,
      })),
      goods: ['grain', 'wood', 'tools'],
      establishments: domain.establishments.map(({ id }) => id),
      production: {
        cityId: 'inland',
        establishmentId: 'inland-workshop',
        commodity: 'tools',
        quantity: state.producer.batchesProduced * 2,
        batches: state.producer.batchesProduced,
        recipe: 'provisional: 2 wood -> 2 tools per batch',
        status: state.producer.status,
        ...(state.producer.stoppedReason ? { stoppedReason: state.producer.stoppedReason } : {}),
      },
      firstTickPrice: {
        commodity: 'grain',
        supplied: 7,
        demanded: 2,
        unitPrice: firstTickUnitPrice,
      },
      trade: {
        cityId: 'harbor',
        commodity: 'grain',
        quantity: harbor.traded,
        total: harbor.total,
        balancesAfter: {
          buyer: account('harbor-households'),
          seller: account('harbor-granary-account'),
        },
      },
      recurring: {
        harbor: {
          demanded: state.tick * 2,
          traded: harbor.traded,
          consumed: harbor.consumed,
          unmet: harbor.unmet,
        },
        inland: {
          demanded: state.tick,
          traded: inland.traded,
          consumed: inland.traded,
          unmet: inland.unmet,
        },
      },
      shipment: {
        shipmentId: shipment.shipmentId,
        commodity: shipment.commodity,
        quantity: shipment.quantity,
        departureTick: shipment.departureTick,
        arrivalTick: shipment.arrivalTick,
        status: 'arrived',
      },
      route: { routeId: configuration.route.routeId, travelTicks: configuration.route.travelTicks },
      finalInventory: state.inventory.balances,
      finalMoney: {
        buyerAccount: account('harbor-households'),
        sellerAccount: account('harbor-granary-account'),
        inlandBuyerAccount: account('inland-households'),
        inlandSellerAccount: account('inland-workshop-account'),
      },
      conservation: {
        grainBefore: 10,
        grainConsumed: harbor.consumed,
        grainAfter,
        moneyBefore: 160,
        moneyAfter: state.money.balances.reduce((sum, b) => sum + b.amount, 0),
      },
    };
  };
  return {
    step: () => {
      world.step();
      return snapshot();
    },
    run: (ticks) => {
      world.run(ticks);
      return snapshot();
    },
    snapshot,
    report,
  };
}

export function createTwoCitySimulation(): TwoCitySimulation {
  return build();
}
export function restoreTwoCitySimulation(snapshot: TwoCitySimulationSnapshot): TwoCitySimulation {
  return build(clone(snapshot));
}
export function runTwoCityScenario(): TwoCityReport {
  const simulation = createTwoCitySimulation();
  simulation.run(100);
  return simulation.report();
}
