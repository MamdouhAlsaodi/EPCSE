import {
  createEngine,
  registerDiplomacy,
  registerGovernment,
  registerLocalEconomy,
  registerLogistics,
  type AccountingState,
  type LocalEconomyConfig,
} from '@epcse/simulation-core';

export interface VerticalSliceOptions {
  seed?: number;
  ticks?: number;
  commodities?: readonly [string, string, string, string, string];
  cohorts?: readonly [string, string];
  road?: { cost: number; duration: number };
  playerChoice?: 'accept' | 'refuse';
  aiMinimumStock?: number;
}
export interface VerticalSliceReport {
  fixtureVersion: number;
  disclaimer: string;
  ticks: number;
  kingdoms: readonly string[];
  cities: readonly string[];
  commodities: readonly string[];
  cohorts: readonly string[];
  governments: readonly string[];
  road: { cost: number; duration: number };
  intervention: { funded: boolean; amount: number; treasuryDebit: number };
  playerDecision: { accepted: boolean; source: 'player' };
  aiDecision: { accepted: boolean; source: 'ai'; reason: string };
  trade: {
    departed: number;
    arrived: number;
    paid: number;
    fundedFreight: boolean;
    accountingBalanced: boolean;
  };
  recurring: { ticksObserved: number; production: number; consumption: number; unmet: number };
  invariants: { nonnegativeMoney: boolean; nonnegativeStock: boolean };
  hashes: { state: string; events: string };
}
const defaults = ['grain', 'wood', 'tools', 'stone', 'cloth'] as const;
export const VERTICAL_SLICE_FIXTURE_VERSION = 1 as const;

function validate(
  options: VerticalSliceOptions,
): Required<
  Pick<VerticalSliceOptions, 'seed' | 'ticks' | 'commodities' | 'cohorts' | 'road' | 'playerChoice'>
> {
  const seed = options.seed ?? 42;
  const ticks = options.ticks ?? 1000;
  const commodities = options.commodities ?? defaults;
  const cohorts = options.cohorts ?? ['farmers', 'craftspeople'];
  const road = options.road ?? { cost: 3, duration: 2 };
  const playerChoice = options.playerChoice ?? 'accept';
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('seed must be uint32');
  if (!Number.isSafeInteger(ticks) || ticks < 2) throw new RangeError('ticks must be at least 2');
  if (
    !Array.isArray(commodities) ||
    commodities.length !== 5 ||
    commodities.some((v) => typeof v !== 'string' || !v.trim()) ||
    new Set(commodities).size !== 5
  )
    throw new TypeError('exactly five unique nonempty commodities are required');
  if (
    !Array.isArray(cohorts) ||
    cohorts.length !== 2 ||
    cohorts.some((v) => typeof v !== 'string' || !v.trim()) ||
    new Set(cohorts).size !== cohorts.length
  )
    throw new TypeError('exactly two unique nonempty cohort names are required');
  if (
    !Number.isSafeInteger(road.cost) ||
    road.cost <= 0 ||
    road.cost > 10 ||
    !Number.isSafeInteger(road.duration) ||
    road.duration <= 0
  )
    throw new RangeError('road cost must be 1..10 and duration must be a positive safe integer');
  if (
    options.aiMinimumStock !== undefined &&
    (!Number.isSafeInteger(options.aiMinimumStock) || options.aiMinimumStock < 0)
  )
    throw new RangeError('AI minimum stock must be a nonnegative safe integer');
  if (playerChoice !== 'accept' && playerChoice !== 'refuse')
    throw new TypeError('invalid player choice');
  return { seed, ticks, commodities, cohorts, road, playerChoice };
}

export function runVerticalSlice(options: VerticalSliceOptions = {}): VerticalSliceReport {
  const { seed, ticks, commodities, cohorts, road, playerChoice } = validate(options);
  const [grain, wood, tools, , cloth] = commodities;
  const kingdoms = ['north', 'south'] as const;
  const cities = ['north-port', 'south-market'] as const;
  const owners = [
    ...kingdoms,
    ...cities,
    ...cohorts.map((_, i) => `cohort-${i}`),
    'farm',
    'mill',
    'carrier',
    'transit',
  ];
  const accounts = [
    { id: 'north-treasury', ownerId: 'north', openingBalance: 1000 },
    { id: 'north-households', ownerId: 'cohort-0', openingBalance: 1000 },
    { id: 'north-benefit', ownerId: 'north', openingBalance: 0 },
    { id: 'south-treasury', ownerId: 'south', openingBalance: 100 },
    { id: 'south-households', ownerId: 'cohort-1', openingBalance: 100 },
    { id: 'south-benefit', ownerId: 'south', openingBalance: 0 },
    { id: 'farm-cash', ownerId: 'farm', openingBalance: 100 },
    { id: 'mill-cash', ownerId: 'mill', openingBalance: 100 },
    { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
  ];
  const ledger = {
    currency: { id: 'coin', unit: 'coin', scale: 0 },
    commodities: commodities.map((id) => ({ id, unit: 'unit', scale: 0 })),
    owners,
    accounts,
    stock: [
      { ownerId: 'farm', commodity: grain, quantity: 100 },
      { ownerId: 'farm', commodity: wood, quantity: 20 },
      { ownerId: 'mill', commodity: wood, quantity: 20 },
      { ownerId: 'mill', commodity: tools, quantity: 100 },
      { ownerId: 'north', commodity: grain, quantity: 30 },
      { ownerId: 'south', commodity: cloth, quantity: 20 },
    ],
    recipes: [
      {
        id: 'grow-grain',
        inputs: [{ commodity: wood, quantity: 1 }],
        outputs: [{ commodity: grain, quantity: 2 }],
      },
      {
        id: 'make-tools',
        inputs: [{ commodity: wood, quantity: 1 }],
        outputs: [{ commodity: tools, quantity: 1 }],
      },
    ],
  };
  const economy: LocalEconomyConfig = {
    ...ledger,
    producers: [
      {
        id: 'grain-farm',
        cityId: cities[0],
        ownerId: 'farm',
        accountId: 'farm-cash',
        recipeId: 'grow-grain',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 1,
      },
      {
        id: 'tool-mill',
        cityId: cities[1],
        ownerId: 'mill',
        accountId: 'mill-cash',
        recipeId: 'make-tools',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 1,
      },
    ],
    cohorts: [
      {
        id: cohorts[0],
        cityId: cities[0],
        ownerId: 'cohort-0',
        accountId: 'north-households',
        workersAvailable: 4,
        desiredNeeds: { [grain]: 1 },
      },
      {
        id: cohorts[1],
        cityId: cities[1],
        ownerId: 'cohort-1',
        accountId: 'south-households',
        workersAvailable: 4,
        desiredNeeds: { [tools]: 1 },
      },
    ],
    sellers: [
      {
        cityId: cities[0],
        commodity: grain,
        ownerId: 'farm',
        accountId: 'farm-cash',
        minPrice: 1,
        maxPrice: 20,
        openingPrice: 2,
      },
      {
        cityId: cities[1],
        commodity: tools,
        ownerId: 'mill',
        accountId: 'mill-cash',
        minPrice: 1,
        maxPrice: 20,
        openingPrice: 2,
      },
    ],
  };
  const engine = createEngine({ worldId: 'vertical-slice' }, seed);
  registerLocalEconomy(engine, economy);
  registerLogistics(engine, {
    ...ledger,
    transitOwnerId: 'transit',
    cities: [...cities],
    cityOwnerIds: { [cities[0]]: 'north', [cities[1]]: 'south' },
    cityKingdomIds: { [cities[0]]: 'north', [cities[1]]: 'south' },
    routes: [
      {
        routeId: 'north-south-road',
        sourceCityId: cities[0],
        destinationCityId: cities[1],
        travelTicks: road.duration,
        capacity: 1000,
        fare: road.cost,
        carrierAccountId: 'carrier-cash',
      },
    ],
  });
  const government = {
    kingdoms: [
      {
        kingdomId: 'north',
        controller: 'player' as const,
        treasuryAccountId: 'north-treasury',
        recipients: [{ kingdomId: 'north', ownerId: 'north', accountId: 'north-benefit' }],
      },
      {
        kingdomId: 'south',
        controller: 'ai' as const,
        treasuryAccountId: 'south-treasury',
        recipients: [{ kingdomId: 'south', ownerId: 'south', accountId: 'south-benefit' }],
      },
    ],
  };
  registerGovernment(engine, government);
  registerDiplomacy(engine, {
    offers: [
      {
        offerId: 'grain-road-offer',
        fromKingdomId: 'north',
        toKingdomId: 'south',
        routeId: 'north-south-road',
        commodity: grain,
      },
    ],
    kingdoms: [
      { kingdomId: 'north', controller: 'player' },
      { kingdomId: 'south', controller: 'ai' },
    ],
    preferences: {
      north: { minimumTreasury: 0, minimumStock: 0 },
      south: { minimumTreasury: 0, minimumStock: options.aiMinimumStock ?? 0 },
    },
  });
  engine.submit({
    commandId: 'player-trade-choice',
    type: 'diplomacy.decision',
    requestedTick: 2,
    payload: {
      offerId: 'grain-road-offer',
      kingdomId: 'north',
      accepted: playerChoice === 'accept',
      reason: 'explicit scenario player choice',
    },
  });
  engine.submit({
    commandId: 'funded-intervention',
    type: 'government.policy',
    requestedTick: 2,
    payload: {
      kingdomId: 'north',
      governmentId: 'north',
      policyId: 'north-food-support',
      recipientKingdomId: 'north',
      recipientOwnerId: 'north',
      recipientAccountId: 'north-benefit',
      amount: 10,
      effectiveTick: 2,
      expiryTick: 2,
    },
  });
  if (ticks >= 3)
    engine.submit({
      commandId: 'shipment-1',
      type: 'logistics.depart',
      requestedTick: 3,
      payload: {
        shipmentId: 'grain-shipment-1',
        routeId: 'north-south-road',
        commodity: grain,
        quantity: 1,
        buyerAccountId: 'north-benefit',
        payment: road.cost,
      },
    });
  engine.run(ticks);
  const view = engine.getState();
  const domain = view.domain;
  const accounting = domain.accounting as AccountingState;
  const logs = accounting.journal;
  const shipments = (domain.logistics as { shipments: Array<{ status: string }> }).shipments;
  const diplomacy = domain.diplomacy as {
    decisions: Array<{ kingdomId: string; accepted: boolean; reason: string }>;
  };
  const governmentState = domain.government as { applied: string[] };
  const totalOpening = accounting.openingBalances.reduce((sum, item) => sum + item.balance, 0);
  const totalMoney = accounting.accounts.reduce((sum, item) => sum + item.balance, 0);
  const player = diplomacy.decisions.find((item) => item.kingdomId === 'north');
  const ai = diplomacy.decisions.find((item) => item.kingdomId === 'south');
  const subsidyIndex = logs.findIndex((entry) => entry.causeId === 'government:north-food-support');
  const freightIndex = logs.findIndex(
    (entry) =>
      entry.causeId === 'logistics:grain-shipment-1:fare' &&
      entry.effects.some(
        (effect) =>
          (effect as { debit?: string; credit?: string }).debit === 'north-benefit' &&
          (effect as { debit?: string; credit?: string }).credit === 'carrier-cash',
      ),
  );
  return {
    fixtureVersion: VERTICAL_SLICE_FIXTURE_VERSION,
    disclaimer:
      'Configurable fictional vertical-slice fixture; simplified rules, not M1 acceptance or approved product data.',
    ticks,
    kingdoms,
    cities,
    commodities,
    cohorts,
    governments: kingdoms,
    road: { cost: road.cost, duration: road.duration },
    intervention: {
      funded: governmentState.applied.includes('north-food-support'),
      amount: 10,
      treasuryDebit: subsidyIndex >= 0 ? 10 : 0,
    },
    playerDecision: { accepted: player?.accepted ?? false, source: 'player' },
    aiDecision: {
      accepted: ai?.accepted ?? false,
      source: 'ai',
      reason: ai?.reason ?? 'no independent decision recorded',
    },
    trade: {
      departed: shipments.length,
      arrived: shipments.filter((item) => item.status === 'arrived').length,
      paid: freightIndex >= 0 ? road.cost : 0,
      fundedFreight: subsidyIndex >= 0 && freightIndex > subsidyIndex,
      accountingBalanced: totalMoney === totalOpening,
    },
    recurring: {
      ticksObserved: ticks,
      production: logs.filter((entry) => entry.type === 'conversion').length,
      consumption: logs.filter((entry) => entry.type === 'consume').length,
      unmet: Object.values(
        (domain.economy as { cohorts: Record<string, { cumulativeUnmet: Record<string, number> }> })
          .cohorts,
      ).reduce(
        (sum, cohort) => sum + Object.values(cohort.cumulativeUnmet).reduce((a, b) => a + b, 0),
        0,
      ),
    },
    invariants: {
      nonnegativeMoney: accounting.accounts.every((item) => item.balance >= 0),
      nonnegativeStock: accounting.stock.every((item) => item.quantity >= 0),
    },
    hashes: { state: view.hash, events: view.eventHash },
  };
}

export function verticalSliceSummary(report: VerticalSliceReport): string[] {
  return [
    `EPCSE VS: vertical-slice fixture v${report.fixtureVersion} (fictional configurable engine integration; not M1 acceptance)`,
    `Seeded engine run: ${report.ticks} ticks; kingdoms ${report.kingdoms.join(', ')}; cities ${report.cities.join(', ')}`,
    `Five configured commodities: ${report.commodities.join(', ')}; cohorts ${report.cohorts.join(', ')}; governments ${report.governments.join(', ')}`,
    `Road: cost ${report.road.cost}, travel ${report.road.duration} ticks; funded intervention ${report.intervention.funded ? 'paid' : 'not funded'} (${report.intervention.treasuryDebit} coin debited)`,
    `Trade decisions: player ${report.playerDecision.accepted ? 'accept' : 'refuse'}; AI ${report.aiDecision.accepted ? 'accept' : 'refuse'} (${report.aiDecision.reason})`,
    `Paid shipment: ${report.trade.departed} departed, ${report.trade.arrived} arrived; freight paid ${report.trade.paid} from funded benefit ${report.trade.fundedFreight}; money balanced ${report.trade.accountingBalanced}`,
    `Recurring economy: ${report.recurring.ticksObserved} ticks; ${report.recurring.production} production conversions, ${report.recurring.consumption} consumptions, unmet ${report.recurring.unmet}`,
    `Invariants: money nonnegative ${report.invariants.nonnegativeMoney}; stock nonnegative ${report.invariants.nonnegativeStock}`,
    `State hash: ${report.hashes.state}`,
    `Event hash: ${report.hashes.events}`,
    report.disclaimer,
  ];
}
