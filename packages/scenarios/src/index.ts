import {
  calculateProvisionalPrice,
  createCityMarket,
  createInventory,
  createMoneyLedger,
  createPopulationLedger,
  createRouteNetwork,
  createWorld,
  createWorldDomain,
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
    recipe: string;
  };
  readonly price: { commodity: Commodity; supplied: number; demanded: number; unitPrice: number };
  readonly trade: {
    cityId: string;
    commodity: Commodity;
    quantity: number;
    total: number;
    balancesAfter: { buyer: number; seller: number };
  };
  readonly shipment: {
    shipmentId: string;
    commodity: Commodity;
    quantity: number;
    departureTick: number;
    arrivalTick: number;
    status: 'arrived';
  };
  readonly finalInventory: readonly { ownerId: string; commodity: Commodity; quantity: number }[];
  readonly finalMoney: { buyerAccount: number; sellerAccount: number };
  readonly conservation: {
    grainBefore: number;
    grainAfter: number;
    moneyBefore: number;
    moneyAfter: number;
  };
}

/** Runs a scripted, in-memory demonstration; it is not a general economic simulation. */
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
    accounts: ['harbor-households', 'harbor-granary-account'],
    balances: [{ accountId: 'harbor-households', amount: 100 }],
  });
  const price = calculateProvisionalPrice({ basePrice: 4, demand: 2, supply: 2, maxPrice: 20 });
  const market = createCityMarket({
    cityId: 'harbor',
    inventory,
    money,
    participants: [
      { ownerId: 'harbor', accountId: 'harbor-households' },
      { ownerId: 'harbor-granary', accountId: 'harbor-granary-account' },
    ],
  });
  const receipt = market.trade({
    cityId: 'harbor',
    buyerId: 'harbor',
    sellerId: 'harbor-granary',
    commodity: 'grain',
    quantity: 3,
    unitPrice: price,
  });
  const tradeMoney = money.getState().balances;
  const tradeAccountAmount = (accountId: string): number =>
    tradeMoney.find((balance) => balance.accountId === accountId)!.amount;
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
  routes.depart({
    shipmentId: 'grain-001',
    routeId: 'harbor-inland',
    commodity: 'grain',
    quantity: 3,
  });
  inventory.produce(
    'inland-workshop',
    {
      inputs: [{ commodity: 'wood', quantity: 2 }],
      outputs: [{ commodity: 'tools', quantity: 2 }],
    },
    2,
  );
  const grainBefore = 10;
  for (let i = 0; i < 100; i += 1) {
    routes.advanceTick();
    world.step();
  }
  const finalInventory = inventory.getState().balances;
  const finalMoney = money.getState().balances;
  const accountAmount = (accountId: string): number =>
    finalMoney.find((balance) => balance.accountId === accountId)!.amount;
  const completedShipment = routes
    .getState()
    .shipments.find(({ shipmentId }) => shipmentId === 'grain-001');
  if (!completedShipment || completedShipment.status !== 'arrived') {
    throw new Error('grain-001 shipment did not arrive');
  }
  const grainAfter = finalInventory
    .filter(({ commodity }) => commodity === 'grain')
    .reduce((sum, balance) => sum + balance.quantity, 0);
  const report: TwoCityReport = {
    title: 'Two-city scripted demonstration',
    disclaimer:
      'Synthetic scripted actions and provisional recipe/price only; not a complete S0 or economic simulation. No automatic population consumption, agents, or general economic dynamics.',
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
      quantity: 4,
      recipe: 'provisional: 2 wood -> 2 tools per batch; 2 batches',
    },
    price: { commodity: 'grain', supplied: 2, demanded: 2, unitPrice: price },
    trade: {
      cityId: receipt.cityId,
      commodity: receipt.commodity,
      quantity: receipt.quantity,
      total: receipt.total,
      balancesAfter: {
        buyer: tradeAccountAmount('harbor-households'),
        seller: tradeAccountAmount('harbor-granary-account'),
      },
    },
    shipment: {
      shipmentId: completedShipment.shipmentId,
      commodity: 'grain',
      quantity: completedShipment.quantity,
      departureTick: completedShipment.departureTick,
      arrivalTick: completedShipment.arrivalTick,
      status: completedShipment.status,
    },
    finalInventory,
    finalMoney: {
      buyerAccount: accountAmount('harbor-households'),
      sellerAccount: accountAmount('harbor-granary-account'),
    },
    conservation: {
      grainBefore,
      grainAfter,
      moneyBefore: 100,
      moneyAfter: finalMoney.reduce((sum, balance) => sum + balance.amount, 0),
    },
  };
  return report;
}
