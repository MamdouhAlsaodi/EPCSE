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
  readonly finalInventory: readonly { ownerId: string; commodity: Commodity; quantity: number }[];
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

/** Runs a synthetic in-memory demonstration; provisional rules are not S0. */
export function runTwoCityScenario(): TwoCityReport {
  const world = createWorld('provisional-two-city-demo');
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
  const inventory = createInventory({
    owners: ['harbor', 'inland', 'harbor-granary', 'inland-workshop', 'transit'],
    balances: [
      { ownerId: 'harbor-granary', commodity: 'grain', quantity: 10 },
      { ownerId: 'inland-workshop', commodity: 'wood', quantity: 4 },
    ],
  });
  const money = createMoneyLedger({
    accounts: [
      'harbor-households',
      'harbor-granary-account',
      'inland-households',
      'inland-workshop-account',
    ],
    balances: [
      { accountId: 'harbor-households', amount: 100 },
      { accountId: 'inland-households', amount: 60 },
    ],
  });
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
    routes: [
      {
        routeId: 'harbor-inland',
        sourceCityId: 'harbor',
        destinationCityId: 'inland',
        travelTicks: 3,
      },
    ],
  });
  inventory.transfer('harbor-granary', 'harbor', 'grain', 3);
  routes.depart({
    shipmentId: 'grain-001',
    routeId: 'harbor-inland',
    commodity: 'grain',
    quantity: 3,
  });
  world.registerTickSystem('route-advancement', () => routes.advanceTick());

  const producer = createRecipeProducer(world, 'inland-workshop', inventory, 'inland-workshop', {
    inputs: [{ commodity: 'wood', quantity: 2 }],
    outputs: [{ commodity: 'tools', quantity: 2 }],
  });
  const harborOutcome = { traded: 0, consumed: 0, unmet: 0, total: 0 };
  let firstTickUnitPrice: number | undefined;
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
      harborOutcome.traded += quantity;
      harborOutcome.unmet += unmetDemand;
      harborOutcome.total += quantity * price;
      if (quantity > 0) {
        inventory.consume('harbor', 'grain', quantity);
        harborOutcome.consumed += quantity;
      }
    },
  });
  const inlandOutcome = { traded: 0, unmet: 0 };
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
  });
  world.registerTickSystem('inland-consumption-reporting', () => {
    const unmet = inlandConsumption.getUnmetNeeds().reduce((sum, need) => sum + need.quantity, 0);
    inlandOutcome.unmet += unmet;
    inlandOutcome.traded += 1 - unmet;
  });
  const initialGrain = 10;
  const initialMoney = 160;
  world.run(100);

  const finalInventory = inventory.getState().balances;
  const finalMoney = money.getState().balances;
  const accountAmount = (accountId: string): number =>
    finalMoney.find(({ accountId: id }) => id === accountId)?.amount ?? 0;
  const completedShipment = routes
    .getState()
    .shipments.find(({ shipmentId }) => shipmentId === 'grain-001');
  if (!completedShipment || completedShipment.status !== 'arrived')
    throw new Error('grain-001 shipment did not arrive');
  const grainAfter = finalInventory
    .filter(({ commodity }) => commodity === 'grain')
    .reduce((sum, balance) => sum + balance.quantity, 0);
  const inlandUnmet = inlandOutcome.unmet;
  const inlandTraded = inlandOutcome.traded;
  const harborUnmet = harborOutcome.unmet;
  const productionState = producer.getState();
  if (firstTickUnitPrice === undefined) throw new Error('first-tick market clearing did not run');
  const report: TwoCityReport = {
    title: 'Two-city scripted demonstration',
    disclaimer:
      'Synthetic scripted actions with provisional recipes and pricing; not a complete S0 or economic simulation. Demand, prices, and production rules are illustrative.',
    tick: world.getState().tick,
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
      quantity: productionState.batchesProduced * 2,
      batches: productionState.batchesProduced,
      recipe: 'provisional: 2 wood -> 2 tools per batch',
      status: productionState.status,
      ...(productionState.stoppedReason ? { stoppedReason: productionState.stoppedReason } : {}),
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
      quantity: harborOutcome.traded,
      total: harborOutcome.total,
      balancesAfter: {
        buyer: accountAmount('harbor-households'),
        seller: accountAmount('harbor-granary-account'),
      },
    },
    recurring: {
      harbor: {
        demanded: 200,
        traded: harborOutcome.traded,
        consumed: harborOutcome.consumed,
        unmet: harborUnmet,
      },
      inland: { demanded: 100, traded: inlandTraded, consumed: inlandTraded, unmet: inlandUnmet },
    },
    shipment: {
      shipmentId: completedShipment.shipmentId,
      commodity: 'grain',
      quantity: completedShipment.quantity,
      departureTick: completedShipment.departureTick,
      arrivalTick: completedShipment.arrivalTick,
      status: 'arrived',
    },
    route: { routeId: 'harbor-inland', travelTicks: 3 },
    finalInventory,
    finalMoney: {
      buyerAccount: accountAmount('harbor-households'),
      sellerAccount: accountAmount('harbor-granary-account'),
      inlandBuyerAccount: accountAmount('inland-households'),
      inlandSellerAccount: accountAmount('inland-workshop-account'),
    },
    conservation: {
      grainBefore: initialGrain,
      grainConsumed: harborOutcome.consumed,
      grainAfter,
      moneyBefore: initialMoney,
      moneyAfter: finalMoney.reduce((sum, balance) => sum + balance.amount, 0),
    },
  };
  return report;
}
