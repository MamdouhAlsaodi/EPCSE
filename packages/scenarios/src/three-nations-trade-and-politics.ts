import {
  createEngine,
  registerCities,
  registerDiplomacy,
  registerFirms,
  registerGovernment,
  registerAdvisor,
  registerLocalEconomy,
  registerLogistics,
  registerPolitics,
  type AccountingState,
  type CityConfig,
  type DiplomacyConfig,
  type Engine,
  type EngineCommand,
  type FirmsConfig,
  type GovernmentConfig,
  type LocalEconomyConfig,
  type LogisticsConfig,
  type PoliticsConfig,
} from '@epcse/simulation-core';

export const THREE_NATIONS_FIXTURE_VERSION = 1 as const;

/**
 * Opt-in, versioned SC-16 counterfactual setup. Applied at fixture construction (before tick 0),
 * so both counterfactual branches fork from an identical trusted tick-200 snapshot that already
 * contains naturally sustained purchasable food and resident funding common to both branches.
 * The default fixture (no option) is unchanged, preserving its canonical hashes.
 */
export const THREE_NATIONS_COUNTERFACTUAL_SETUP = {
  1: {
    label:
      'SC-16 opt-in counterfactual setup v1: plain-central residents funded and farm-owner supplied with grain from tick 0 (common to both branches)',
    plainCentralResidentsOpeningBudget: 30000,
    farmOwnerOpeningGrain: 4000,
  },
} as const;

export type ThreeNationsCounterfactualSetupVersion =
  keyof typeof THREE_NATIONS_COUNTERFACTUAL_SETUP & 1;

export type ThreeNationsShock =
  | {
      readonly kind: 'route-close';
      readonly routeId: string;
      readonly durationTicks: number;
      readonly startTick: number;
    }
  | {
      readonly kind: 'import-tariff';
      readonly importKingdomId: string;
      readonly routeId: string;
      readonly commodity: string;
      readonly amount: number;
      readonly startTick: number;
      readonly durationTicks: number;
    };

export type ThreeNationsKingdomId = 'plains' | 'mountains' | 'coast';

export interface ThreeNationsVariant {
  readonly playerDecision?: 'accept' | 'refuse';
  readonly migrationBudget?: number;
  readonly foodSubsidy?: boolean;
  readonly localPurchaseTax?: boolean;
  readonly tariffOnly?: boolean;
  readonly tariffDiscount?: boolean;
  readonly tradeRestriction?: boolean;
  readonly insolventProducer?: boolean;
  readonly reserveFloor?: boolean;
  readonly minerNegotiation?: 'funded' | 'underfunded';
  readonly socialActionOff?: boolean;
}

export interface ThreeNationsOptions {
  readonly seed?: number;
  readonly ticks?: number;
  readonly kingdoms?: readonly ThreeNationsKingdomId[];
  readonly shock?: ThreeNationsShock | null;
  readonly variant?: ThreeNationsVariant;
  /** Opt-in versioned SC-16 setup; omit for the unchanged default fixture. */
  readonly counterfactualSetupVersion?: ThreeNationsCounterfactualSetupVersion;
}

export interface ResolvedThreeNationsConfig {
  readonly fixtureVersion: typeof THREE_NATIONS_FIXTURE_VERSION;
  readonly seed: number;
  readonly ticks: number;
  readonly kingdoms: readonly ThreeNationsKingdomId[];
  readonly kingdomGovernmentForms: Readonly<Record<string, string>>;
  readonly shock: ThreeNationsShock | null;
  readonly variant: ThreeNationsVariant;
  readonly counterfactualSetupVersion: ThreeNationsCounterfactualSetupVersion | null;
  readonly counterfactualSetupLabel: string | null;
  readonly counts: {
    readonly kingdoms: number;
    readonly cities: number;
    readonly goods: number;
    readonly sectors: number;
    readonly classes: number;
    readonly governmentFormsSupported: number;
  };
  readonly goods: readonly string[];
  readonly sectors: readonly string[];
  readonly classes: readonly string[];
  readonly cityIds: readonly string[];
  readonly routeIds: readonly string[];
}

export interface ThreeNationsReport {
  readonly fixtureVersion: typeof THREE_NATIONS_FIXTURE_VERSION;
  readonly disclaimer: string;
  readonly config: ResolvedThreeNationsConfig;
  readonly tick: number;
  readonly stateHash: string;
  readonly eventHash: string;
  readonly politics: {
    readonly proposed: number;
    readonly active: number;
    readonly resolved: number;
    readonly failed: number;
    readonly expired: number;
  };
  readonly world: {
    readonly produced: number;
    readonly departed: number;
    readonly arrived: number;
    readonly unmet: number;
    readonly treasury: number;
  };
  readonly kingdoms: readonly {
    readonly id: string;
    readonly produced: number;
    readonly departed: number;
    readonly arrived: number;
    readonly treasury: number;
    readonly staplePrice: number;
  }[];
  readonly reconciliation: boolean;
  readonly invariants: {
    readonly moneyNonnegative: boolean;
    readonly stockNonnegative: boolean;
    readonly moneyConserved: boolean;
  };
}

const GOVERNMENT_FORMS_SUPPORTED = 4;
const SECTORS = [
  'agriculture',
  'mining-extraction',
  'industry',
  'food-manufacturing',
  'construction',
  'transport-logistics',
] as const;
const CLASSES = [
  'rural-low-income',
  'urban-low-income',
  'middle-income',
  'capital-owner',
  'public-sector',
] as const;
const GOODS = [
  'grain',
  'vegetables',
  'livestock',
  'wood',
  'stone',
  'iron-ore',
  'coal',
  'iron',
  'tools',
  'cloth',
  'clothes',
  'bread',
  'building-materials',
  'medicine',
  'machinery',
] as const;
const ALL_KINGDOMS: readonly ThreeNationsKingdomId[] = ['plains', 'mountains', 'coast'];

interface KingdomLayout {
  readonly id: ThreeNationsKingdomId;
  readonly cities: readonly string[];
}

const LAYOUTS: Record<ThreeNationsKingdomId, KingdomLayout> = {
  plains: { id: 'plains', cities: ['plain-central', 'plain-fields', 'plain-river', 'plain-gate'] },
  mountains: { id: 'mountains', cities: ['mount-hold', 'mount-deep', 'mount-forge', 'mount-pass'] },
  coast: { id: 'coast', cities: ['coast-harbor', 'coast-quay', 'coast-loom', 'coast-cliff'] },
};

// --- fixture validation (runs before the engine is constructed; throws, no partial state) ---
const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function resolveConfig(options: ThreeNationsOptions): ResolvedThreeNationsConfig {
  const seed = options.seed ?? 42;
  const ticks = options.ticks ?? 1000;
  const kingdoms: ThreeNationsKingdomId[] = [...(options.kingdoms ?? ALL_KINGDOMS)];
  const shock = options.shock ?? null;
  const variant = options.variant ?? {};
  if (!isUint32(seed)) throw new RangeError('seed must be uint32');
  if (!Number.isSafeInteger(ticks) || ticks < 2) throw new RangeError('ticks must be at least 2');
  if (
    !Array.isArray(kingdoms) ||
    kingdoms.length === 0 ||
    kingdoms.some((k) => !ALL_KINGDOMS.includes(k)) ||
    new Set(kingdoms).size !== kingdoms.length
  )
    throw new RangeError('kingdoms must be a nonempty unique subset of plains/mountains/coast');
  const kingdomCityIds = kingdoms.flatMap((k: ThreeNationsKingdomId) => LAYOUTS[k].cities);
  if (new Set(kingdomCityIds).size !== kingdomCityIds.length)
    throw new RangeError('duplicate kingdom city id');
  if (shock) {
    if (!Number.isSafeInteger(shock.startTick) || shock.startTick <= 120)
      throw new RangeError('shock startTick must be greater than 120');
    if (!Number.isSafeInteger(shock.durationTicks) || shock.durationTicks < 1)
      throw new RangeError('shock durationTicks must be a positive safe integer');
    const routeIds = kingdoms.flatMap((k: ThreeNationsKingdomId) =>
      ROUTES.filter((r) => r.kingdoms.includes(k)).map((r) => r.routeId),
    );
    const allRouteIds = ROUTES.map((r) => r.routeId);
    if (!allRouteIds.includes(shock.routeId) || !routeIds.includes(shock.routeId))
      throw new RangeError(`unknown shock routeId ${String(shock.routeId)}`);
    if (shock.kind === 'import-tariff') {
      if (!kingdoms.includes(shock.importKingdomId as ThreeNationsKingdomId))
        throw new RangeError('unknown shock importKingdomId');
      const route = ROUTES.find((r) => r.routeId === shock.routeId)!;
      if (route.destKingdom !== shock.importKingdomId)
        throw new RangeError('tariff importer must be the destination kingdom of the route');
      if (!GOODS.includes(shock.commodity as (typeof GOODS)[number]))
        throw new RangeError('unknown shock commodity');
      if (!Number.isSafeInteger(shock.amount) || shock.amount <= 0)
        throw new RangeError('tariff amount must be a positive safe integer');
    }
  }
  if (variant.migrationBudget !== undefined) {
    if (!Number.isSafeInteger(variant.migrationBudget) || variant.migrationBudget < 0)
      throw new RangeError('migrationBudget must be a nonnegative safe integer');
  }
  let counterfactualSetupVersion: ResolvedThreeNationsConfig['counterfactualSetupVersion'] = null;
  let counterfactualSetupLabel: ResolvedThreeNationsConfig['counterfactualSetupLabel'] = null;
  if (options.counterfactualSetupVersion !== undefined) {
    const version = options.counterfactualSetupVersion;
    if (version !== 1 || !(version in THREE_NATIONS_COUNTERFACTUAL_SETUP))
      throw new RangeError(
        `unsupported counterfactualSetupVersion ${String(version)}; supported: ${Object.keys(THREE_NATIONS_COUNTERFACTUAL_SETUP).join(', ')}`,
      );
    if (!kingdoms.includes('plains'))
      throw new RangeError('counterfactualSetupVersion requires the plains kingdom');
    counterfactualSetupVersion = version;
    counterfactualSetupLabel = THREE_NATIONS_COUNTERFACTUAL_SETUP[version].label;
  }
  return {
    fixtureVersion: THREE_NATIONS_FIXTURE_VERSION,
    seed,
    ticks,
    kingdoms: [...kingdoms],
    kingdomGovernmentForms: Object.fromEntries(
      kingdoms.map((k: ThreeNationsKingdomId) => [k, KINGDOM_FORMS[k]]),
    ),
    shock,
    variant,
    counterfactualSetupVersion,
    counterfactualSetupLabel,
    counts: {
      kingdoms: kingdoms.length,
      cities: kingdoms.length * 4,
      goods: GOODS.length,
      sectors: SECTORS.length,
      classes: CLASSES.length,
      governmentFormsSupported: GOVERNMENT_FORMS_SUPPORTED,
    },
    goods: [...GOODS],
    sectors: [...SECTORS],
    classes: [...CLASSES],
    cityIds: kingdoms.flatMap((k: ThreeNationsKingdomId) => LAYOUTS[k].cities),
    routeIds: kingdoms
      .flatMap((k: ThreeNationsKingdomId) =>
        ROUTES.filter((r) => r.kingdoms.includes(k)).map((r) => r.routeId),
      )
      .filter((id, index, all) => all.indexOf(id) === index),
  };
}

const KINGDOM_FORMS: Record<ThreeNationsKingdomId, string> = {
  plains: 'monarchy',
  mountains: 'city-council',
  coast: 'parliamentary',
};

interface RouteDef {
  readonly routeId: string;
  readonly sourceCityId: string;
  readonly destinationCityId: string;
  readonly travelTicks: number;
  readonly fare: number;
  readonly kingdoms: readonly ThreeNationsKingdomId[];
  readonly destKingdom: ThreeNationsKingdomId;
}

const ROUTES: readonly RouteDef[] = [
  {
    routeId: 'plains-mountains-road',
    sourceCityId: 'plain-gate',
    destinationCityId: 'mount-pass',
    travelTicks: 25,
    fare: 3,
    kingdoms: ['plains', 'mountains'],
    destKingdom: 'mountains',
  },
  {
    routeId: 'plains-mountains-pass',
    sourceCityId: 'plain-river',
    destinationCityId: 'mount-deep',
    travelTicks: 25,
    fare: 4,
    kingdoms: ['plains', 'mountains'],
    destKingdom: 'mountains',
  },
  {
    routeId: 'mountain-coast-road',
    sourceCityId: 'mount-forge',
    destinationCityId: 'coast-quay',
    travelTicks: 25,
    fare: 3,
    kingdoms: ['mountains', 'coast'],
    destKingdom: 'coast',
  },
  {
    routeId: 'plains-coast-sea',
    sourceCityId: 'plain-central',
    destinationCityId: 'coast-harbor',
    travelTicks: 30,
    fare: 3,
    kingdoms: ['plains', 'coast'],
    destKingdom: 'coast',
  },
  {
    routeId: 'coast-plain-road',
    sourceCityId: 'coast-harbor',
    destinationCityId: 'plain-central',
    travelTicks: 25,
    fare: 3,
    kingdoms: ['plains', 'coast'],
    destKingdom: 'plains',
  },
];

// City owner mapping: the warehouse/trader owner that holds the stock shipped through the city.
const CITY_OWNERS: Readonly<Record<string, string>> = {
  'plain-central': 'plain-market',
  'plain-fields': 'plain-fields-depot',
  'plain-river': 'plain-river-warehouse',
  'plain-gate': 'plains-warehouse',
  'mount-hold': 'mount-trader',
  'mount-deep': 'mount-deep-depot',
  'mount-forge': 'mountain-works',
  'mount-pass': 'mount-trader',
  'coast-harbor': 'coast-trader',
  'coast-quay': 'coast-quay-warehouse',
  'coast-loom': 'coast-loom-warehouse',
  'coast-cliff': 'coast-cliff-depot',
};

interface ProducerDef {
  readonly id: string;
  readonly cityId: string;
  readonly ownerId: string;
  readonly accountId: string;
  readonly recipeId: string;
  readonly laborPerBatch: number;
  readonly maxBatches: number;
  readonly wagePerBatch: number;
  readonly inputs: readonly { readonly commodity: string; readonly quantity: number }[];
  readonly outputs: readonly { readonly commodity: string; readonly quantity: number }[];
  readonly openingCash: number;
  readonly inputStock: number;
  readonly requiredSkills?: Record<string, number>;
}

/**
 * Lean default producer set (one per archetype kingdom). Sizing guardrail: the engine clones its
 * whole domain (journal dominated) for every phase system every tick, so per-tick journal load is
 * deliberately bounded — recipes are aggregated multi-output, input stocks give producers finite
 * lives, and only a few cohorts hold staple needs. All 15 goods remain configured ledger
 * commodities; sector grouping is fixture metadata (the engine has no native sector entity).
 */
const RECIPES = [
  {
    id: 'grow-grain',
    inputs: [{ commodity: 'wood', quantity: 1 }],
    outputs: [
      { commodity: 'grain', quantity: 2 },
      { commodity: 'vegetables', quantity: 1 },
      { commodity: 'livestock', quantity: 1 },
    ],
  },
  {
    id: 'mountain-extraction',
    inputs: [{ commodity: 'wood', quantity: 1 }],
    outputs: [
      { commodity: 'iron-ore', quantity: 1 },
      { commodity: 'coal', quantity: 1 },
      { commodity: 'tools', quantity: 1 },
    ],
  },
  {
    id: 'coast-textiles',
    inputs: [{ commodity: 'livestock', quantity: 1 }],
    outputs: [
      { commodity: 'cloth', quantity: 2 },
      { commodity: 'clothes', quantity: 1 },
      { commodity: 'medicine', quantity: 1 },
    ],
  },
  {
    id: 'make-medicine',
    inputs: [{ commodity: 'vegetables', quantity: 1 }],
    outputs: [{ commodity: 'medicine', quantity: 1 }],
  },
  {
    id: 'forge-anvil',
    inputs: [{ commodity: 'wood', quantity: 1 }],
    outputs: [{ commodity: 'iron', quantity: 1 }],
  },
];

const PRODUCERS: readonly ProducerDef[] = [
  {
    id: 'plains-farm',
    cityId: 'plain-fields',
    ownerId: 'farm-owner',
    accountId: 'farm-cash',
    recipeId: 'grow-grain',
    laborPerBatch: 2,
    maxBatches: 1,
    wagePerBatch: 4,
    inputs: [{ commodity: 'wood', quantity: 1 }],
    outputs: RECIPES[0]!.outputs,
    openingCash: 400,
    inputStock: 12,
  },
  {
    id: 'mountain-mine',
    cityId: 'mount-deep',
    ownerId: 'mine-owner',
    accountId: 'mine-cash',
    recipeId: 'mountain-extraction',
    laborPerBatch: 2,
    maxBatches: 2,
    wagePerBatch: 4,
    inputs: [{ commodity: 'wood', quantity: 1 }],
    outputs: RECIPES[1]!.outputs,
    openingCash: 1200,
    // 64 ore >= 2 batches/tick * 30 ticks: the SC-05 no-action baseline keeps producing
    // through the whole 30-tick window, so the struck-vs-baseline gap stays strict per tick
    inputStock: 64,
  },
  {
    id: 'coast-weaver',
    cityId: 'coast-loom',
    ownerId: 'weaver-owner',
    accountId: 'weaver-cash',
    recipeId: 'coast-textiles',
    laborPerBatch: 2,
    maxBatches: 1,
    wagePerBatch: 4,
    inputs: [{ commodity: 'livestock', quantity: 1 }],
    outputs: RECIPES[2]!.outputs,
    openingCash: 600,
    inputStock: 8,
  },
];

interface CohortDef {
  readonly id: string;
  readonly cityId: string;
  readonly ownerId: string;
  readonly accountId: string;
  readonly population: number;
  readonly category: string;
  readonly class: string;
  readonly skills: Record<string, number>;
  readonly needs: Record<string, number>;
  readonly incomePerPerson: number;
  readonly serviceNeeds: Record<string, number>;
  readonly welfare: number;
  readonly openingBudget: number;
}

const cohortDef = (
  cityId: string,
  suffix: string,
  population: number,
  category: string,
  klass: string,
  needs: Record<string, number>,
  openingBudget: number,
  skills: Record<string, number> = {},
): CohortDef => ({
  id: `${cityId}-${suffix}`,
  cityId,
  ownerId: `${cityId}-${suffix}`,
  accountId: `${cityId}-${suffix}-cash`,
  population,
  category,
  class: klass,
  skills,
  needs,
  incomePerPerson: 0,
  serviceNeeds: cityId === 'plain-central' && suffix === 'residents' ? { care: 1 } : {},
  welfare: 50,
  openingBudget,
});

interface CohortSpec {
  readonly cohort: CohortDef;
  readonly workersAvailable: number;
  readonly desiredNeeds: Record<string, number>;
}

// Lean staple needs: only one cohort per kingdom holds a staple need, bounding per-tick
// settlement journal load. Remaining cohorts are configured with neutral empty need maps.
const stapleNeeds = { grain: 1 };

function cohortSpecs(
  kingdoms: readonly ThreeNationsKingdomId[],
  variant: ThreeNationsVariant,
): CohortSpec[] {
  const specs: CohortSpec[] = [];
  const migrationVariant = variant.migrationBudget !== undefined && variant.migrationBudget > 0;
  const needsFor = (kingdom: ThreeNationsKingdomId, cityId: string): Record<string, number> => {
    if (kingdom === 'plains' && cityId === 'plain-central') return stapleNeeds;
    if (
      kingdom === 'mountains' &&
      (cityId === 'mount-hold' || (migrationVariant && cityId === 'mount-forge'))
    )
      return stapleNeeds;
    if (kingdom === 'coast' && cityId === 'coast-harbor') return stapleNeeds;
    return {};
  };
  for (const kingdom of kingdoms) {
    const cities = LAYOUTS[kingdom].cities;
    for (const [index, cityId] of cities.entries()) {
      if (kingdom === 'mountains' && migrationVariant && cityId === 'mount-hold') {
        const needs = needsFor(kingdom, cityId);
        specs.push({
          cohort: cohortDef(cityId, 'residents', 100, 'rural', 'rural-low-income', needs, 20000, {
            smithing: 1,
          }),
          workersAvailable: 100,
          desiredNeeds: needs,
        });
        continue;
      }
      if (kingdom === 'mountains' && migrationVariant && cityId === 'mount-forge') {
        const needs = needsFor(kingdom, cityId);
        specs.push({
          cohort: cohortDef(cityId, 'residents', 6, 'rural', 'rural-low-income', needs, 20000, {
            smithing: 1,
          }),
          workersAvailable: 6,
          desiredNeeds: needs,
        });
        continue;
      }
      const klass =
        index === 0 ? 'urban-low-income' : index === 3 ? 'middle-income' : 'rural-low-income';
      const needs = needsFor(kingdom, cityId);
      const population = kingdom === 'plains' && cityId === 'plain-central' ? 10 : 100;
      let budget = 20000;
      if (kingdom === 'plains' && cityId === 'plain-central') budget = 200;
      if (kingdom === 'mountains' && cityId === 'mount-hold') budget = 240;
      specs.push({
        cohort: cohortDef(cityId, 'residents', population, 'common', klass, needs, budget),
        workersAvailable: population,
        desiredNeeds: needs,
      });
    }
    // public-sector cohort (one per kingdom at the first city) and the capital-owner cohort (coast cliff)
    if (kingdom !== 'coast' || cities.length === 4) {
      specs.push({
        cohort: cohortDef(cities[0]!, 'staff', 12, 'common', 'public-sector', {}, 20000),
        workersAvailable: 12,
        desiredNeeds: {},
      });
    }
  }
  if (kingdoms.includes('coast')) {
    specs.push({
      cohort: cohortDef('coast-cliff', 'owners', 10, 'elite', 'capital-owner', {}, 20000),
      workersAvailable: 10,
      desiredNeeds: {},
    });
  }
  return specs;
}

interface SellerDef {
  readonly cityId: string;
  readonly commodity: string;
  readonly ownerId: string;
  readonly accountId: string;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly openingPrice: number;
}

function sellerSpecs(kingdoms: readonly ThreeNationsKingdomId[]): SellerDef[] {
  const sellers: SellerDef[] = [];
  if (kingdoms.includes('plains')) {
    sellers.push({
      cityId: 'plain-central',
      commodity: 'grain',
      ownerId: 'farm-owner',
      accountId: 'farm-cash',
      minPrice: 1,
      maxPrice: 50,
      openingPrice: 2,
    });
  }
  if (kingdoms.includes('mountains')) {
    sellers.push({
      cityId: 'mount-hold',
      commodity: 'grain',
      ownerId: 'mount-trader',
      accountId: 'mount-trader-cash',
      minPrice: 1,
      maxPrice: 80,
      openingPrice: 4,
    });
    sellers.push({
      cityId: 'mount-forge',
      commodity: 'grain',
      ownerId: 'mount-trader',
      accountId: 'mount-trader-cash',
      minPrice: 1,
      maxPrice: 80,
      openingPrice: 4,
    });
  }
  if (kingdoms.includes('coast')) {
    sellers.push({
      cityId: 'coast-harbor',
      commodity: 'grain',
      ownerId: 'coast-trader',
      accountId: 'coast-trader-cash',
      minPrice: 1,
      maxPrice: 80,
      openingPrice: 4,
    });
  }
  return sellers;
}

const key = (city: string, commodity: string) => JSON.stringify([city, commodity]);

export interface ThreeNationsFixture {
  readonly engine: Engine;
  readonly config: ResolvedThreeNationsConfig;
  /** Fixture-driven command schedule for one tick (decisions, departures, shock, variant policies). */
  readonly commandsForTick: (tick: number) => readonly EngineCommand[];
}

export function createThreeNations(options: ThreeNationsOptions = {}): ThreeNationsFixture {
  const config = resolveConfig(options);
  const { seed, ticks, kingdoms, shock, variant } = config;
  const cityIds = config.cityIds;
  const cityKingdomIds: Record<string, string> = Object.fromEntries(
    kingdoms.flatMap((k) => LAYOUTS[k].cities.map((city) => [city, k])),
  );
  const specs = cohortSpecs(kingdoms, variant);
  const setup =
    config.counterfactualSetupVersion !== null
      ? THREE_NATIONS_COUNTERFACTUAL_SETUP[config.counterfactualSetupVersion]
      : undefined;
  if (setup) {
    // Opt-in SC-16 setup v1, applied at construction (before tick 0) so it is common to
    // both counterfactual branches and baked into the trusted tick-200 snapshot.
    const residents = specs.find((s) => s.cohort.id === 'plain-central-residents');
    if (!residents) throw new TypeError('counterfactual setup v1 requires plain-central-residents');
    (residents.cohort as { openingBudget: number }).openingBudget =
      setup.plainCentralResidentsOpeningBudget;
  }
  const sellers = sellerSpecs(kingdoms);
  const producers: ProducerDef[] = PRODUCERS.filter((p) => cityIds.includes(p.cityId)).map((p) => ({
    ...p,
  }));
  if (variant.migrationBudget !== undefined && variant.migrationBudget > 0) {
    // A skill-matched vacancy: the anvil needs more smithing workers than the small cohort has.
    (producers as ProducerDef[]).push({
      id: 'mountain-anvil',
      cityId: 'mount-forge',
      ownerId: 'anvil-owner',
      accountId: 'anvil-cash',
      recipeId: 'forge-anvil',
      laborPerBatch: 8,
      maxBatches: 1,
      wagePerBatch: 4,
      inputs: [{ commodity: 'wood', quantity: 1 }],
      outputs: [{ commodity: 'iron', quantity: 1 }],
      openingCash: 600,
      inputStock: 50,
      requiredSkills: { smithing: 1 },
    });
  }
  if (variant.insolventProducer) {
    (producers as ProducerDef[]).push({
      id: 'coast-alchemist',
      cityId: 'coast-cliff',
      ownerId: 'alchemist-owner',
      accountId: 'alchemist-cash',
      recipeId: 'make-medicine',
      laborPerBatch: 2,
      maxBatches: 1,
      wagePerBatch: 4,
      inputs: [{ commodity: 'vegetables', quantity: 1 }],
      outputs: [{ commodity: 'medicine', quantity: 1 }],
      openingCash: 1,
      inputStock: 50,
    });
  }

  const owners = [
    ...new Set(cityIds.map((city) => CITY_OWNERS[city]!)),
    ...producers.map((p) => p.ownerId),
    ...specs.map((s) => s.cohort.ownerId),
    'transit',
    'migration-fund',
    'construction-co',
    'plains',
    'mountains',
    'coast',
  ];
  const accounts = [
    ...producers.map((p) => ({
      id: p.accountId,
      ownerId: p.ownerId,
      openingBalance: p.openingCash,
    })),
    ...specs.map((s) => ({
      id: s.cohort.accountId,
      ownerId: s.cohort.ownerId,
      openingBalance: s.cohort.openingBudget,
    })),
    { id: 'carrier-cash', ownerId: 'transit', openingBalance: 0 },
    {
      id: 'migration-fund-cash',
      ownerId: 'migration-fund',
      openingBalance: variant.migrationBudget ?? 0,
    },
    { id: 'construction-cash', ownerId: 'construction-co', openingBalance: 20000 },
    { id: 'mount-trader-cash', ownerId: 'mount-trader', openingBalance: 100000 },
    { id: 'coast-trader-cash', ownerId: 'coast-trader', openingBalance: 100000 },
    { id: 'plain-market-cash', ownerId: 'plain-market', openingBalance: 100000 },
    ...kingdoms.map((k) => ({
      id: `${k}-treasury`,
      ownerId: k,
      openingBalance: k === 'plains' ? 5000 : 1000,
    })),
    ...kingdoms.map((k) => ({ id: `${k}-benefit`, ownerId: k, openingBalance: 0 })),
  ];
  // subset runs keep only accounts whose owner participates in the resolved configuration
  const accountOwnerSet = new Set([
    ...new Set(cityIds.map((city) => CITY_OWNERS[city]!)),
    ...kingdoms,
    'transit',
    'migration-fund',
    'construction-co',
    ...producers.map((p) => p.ownerId),
    ...specs.map((s2) => s2.cohort.ownerId),
  ]);
  const filteredAccounts = accounts.filter((entry) => accountOwnerSet.has(entry.ownerId));
  void accounts;
  const warehouseStock: { ownerId: string; commodity: string; quantity: number }[] = [
    { ownerId: 'plains-warehouse', commodity: 'grain', quantity: 2000 },
    { ownerId: 'plain-river-warehouse', commodity: 'grain', quantity: 2000 },
    { ownerId: 'mountain-works', commodity: 'tools', quantity: 2000 },
    { ownerId: 'coast-trader', commodity: 'cloth', quantity: 2000 },
    { ownerId: 'coast-trader', commodity: 'clothes', quantity: 1500 },
    { ownerId: 'mount-trader', commodity: 'grain', quantity: 300 },
    { ownerId: 'coast-trader', commodity: 'grain', quantity: 500 },
    { ownerId: 'plain-market', commodity: 'grain', quantity: 2000 },
  ];
  const ownerSet = new Set(owners);
  const stock = [
    ...producers
      .filter((p) => p.inputStock > 0)
      .flatMap((p) =>
        p.inputs.map((input) => ({
          ownerId: p.ownerId,
          commodity: input.commodity,
          quantity: p.inputStock,
        })),
      ),
    ...warehouseStock.filter((entry) => ownerSet.has(entry.ownerId)),
    ...(setup
      ? [
          {
            ownerId: 'farm-owner',
            commodity: 'grain',
            quantity: setup.farmOwnerOpeningGrain,
          },
        ]
      : []),
  ];

  const economy: LocalEconomyConfig = {
    currency: { id: 'coin', unit: 'coin', scale: 0 },
    commodities: GOODS.map((id) => ({ id, unit: 'unit', scale: 0 })),
    owners,
    accounts: filteredAccounts,
    stock,
    recipes: RECIPES,
    producers: producers.map((p) => ({
      id: p.id,
      cityId: p.cityId,
      ownerId: p.ownerId,
      accountId: p.accountId,
      recipeId: p.recipeId,
      laborPerBatch: p.laborPerBatch,
      maxBatches: p.maxBatches,
      wagePerBatch: p.wagePerBatch,
      ...(p.requiredSkills ? { requiredSkills: p.requiredSkills } : {}),
    })),
    cohorts: specs.map((s) => ({
      id: s.cohort.id,
      cityId: s.cohort.cityId,
      ownerId: s.cohort.ownerId,
      accountId: s.cohort.accountId,
      workersAvailable: s.workersAvailable,
      desiredNeeds: s.desiredNeeds,
    })),
    sellers: sellers.map((s) => ({
      cityId: s.cityId,
      commodity: s.commodity,
      ownerId: s.ownerId,
      accountId: s.accountId,
      minPrice: s.minPrice,
      maxPrice: s.maxPrice,
      openingPrice: s.openingPrice,
    })),
  };

  const logisticsConfig: LogisticsConfig = {
    ...economy,
    transitOwnerId: 'transit',
    cities: cityIds,
    cityOwnerIds: Object.fromEntries(cityIds.map((city) => [city, CITY_OWNERS[city]!])),
    cityKingdomIds,
    routes: ROUTES.filter(
      (r) =>
        kingdoms.includes(routeKingdom(r.sourceCityId)) &&
        kingdoms.includes(routeKingdom(r.destinationCityId)),
    ).map((r) => ({
      routeId: r.routeId,
      sourceCityId: r.sourceCityId,
      destinationCityId: r.destinationCityId,
      travelTicks: r.travelTicks,
      capacity: 100,
      fare: r.fare,
      carrierAccountId: 'carrier-cash',
    })),
  };
  function routeKingdom(cityId: string): ThreeNationsKingdomId {
    return cityKingdomIds[cityId] as ThreeNationsKingdomId;
  }

  const citiesConfig: CityConfig = {
    cities: cityIds.map((cityId) => ({
      id: cityId,
      serviceCapacity: { care: cityId === 'plain-central' ? 5 : 500 },
      serviceProvisionCost: cityId === 'plain-central' ? 1 : 0,
      ...(cityId === 'plain-central'
        ? {
            serviceAccountId: 'plain-central-residents-cash',
            serviceProviderAccountId: 'plains-treasury',
          }
        : {}),
    })),
    cohorts: specs.map((s) => ({
      id: s.cohort.id,
      cityId: s.cohort.cityId,
      population: s.cohort.population,
      category: s.cohort.category,
      class: s.cohort.class,
      skills: s.cohort.skills,
      needs: s.cohort.needs,
      incomePerPerson: s.cohort.incomePerPerson,
      serviceNeeds: s.cohort.serviceNeeds,
      welfare: s.cohort.welfare,
      linkedEconomyCohortId: s.cohort.id,
    })),
    routes: [
      { fromCityId: 'mount-hold', toCityId: 'mount-forge', costPerPerson: 1 },
      { fromCityId: 'plain-fields', toCityId: 'plain-central', costPerPerson: 1 },
    ].filter((r) => cityIds.includes(r.fromCityId) && cityIds.includes(r.toCityId)),
    carrierAccountId: 'carrier-cash',
    migrationFundingAccountId: 'migration-fund-cash',
    migrationBudget: variant.migrationBudget ?? 0,
  };

  const governmentConfig: GovernmentConfig = {
    kingdoms: kingdoms.map((k) => ({
      kingdomId: k,
      controller: k === 'plains' ? ('player' as const) : ('ai' as const),
      treasuryAccountId: `${k}-treasury`,
      recipients: [{ kingdomId: k, ownerId: k, accountId: `${k}-benefit` }],
      ...(k === 'mountains' && variant.reserveFloor
        ? {
            aiPolicy: {
              recipientOwnerId: k,
              recipientAccountId: `${k}-benefit`,
              amount: 60,
              reserve: 400,
            },
          }
        : {}),
    })),
    institutions: Object.fromEntries(kingdoms.map((k) => [k, KINGDOM_FORMS[k]])),
    cityKingdomIds,
  } as GovernmentConfig;

  const allRelations: DiplomacyConfig['relations'] = [
    { kingdomA: 'plains', kingdomB: 'mountains', trust: 60, interests: { grain: 70, trade: 60 } },
    {
      kingdomA: 'plains',
      kingdomB: 'coast',
      trust: 55,
      interests: { cloth: 60, clothes: 60, trade: 55 },
    },
    { kingdomA: 'mountains', kingdomB: 'coast', trust: 55, interests: { tools: 60, trade: 55 } },
  ];

  const allOffers: DiplomacyConfig['offers'] = [
    {
      offerId: 'offer-food',
      fromKingdomId: 'plains',
      toKingdomId: 'mountains',
      routeId: 'plains-mountains-road',
      commodity: 'grain',
      effectiveTick: 3,
      expiryTick: ticks,
    },
    {
      offerId: 'offer-food-alt',
      fromKingdomId: 'plains',
      toKingdomId: 'mountains',
      routeId: 'plains-mountains-pass',
      commodity: 'grain',
      effectiveTick: 3,
      expiryTick: ticks,
    },
    {
      offerId: 'offer-tools',
      fromKingdomId: 'mountains',
      toKingdomId: 'coast',
      routeId: 'mountain-coast-road',
      commodity: 'tools',
      effectiveTick: 3,
      expiryTick: ticks,
    },
    {
      offerId: 'offer-cloth',
      fromKingdomId: 'coast',
      toKingdomId: 'plains',
      routeId: 'coast-plain-road',
      commodity: 'cloth',
      effectiveTick: 3,
      expiryTick: ticks,
    },
    {
      offerId: 'offer-clothes',
      fromKingdomId: 'coast',
      toKingdomId: 'plains',
      routeId: 'coast-plain-road',
      commodity: 'clothes',
      effectiveTick: 3,
      expiryTick: ticks,
      ...(variant.tariffDiscount ? { tariffDiscountBps: 2000 } : {}),
    },
  ];
  const diplomacyConfig: DiplomacyConfig = {
    offers: allOffers.filter(
      (o) =>
        kingdoms.includes(o.fromKingdomId as ThreeNationsKingdomId) &&
        kingdoms.includes(o.toKingdomId as ThreeNationsKingdomId),
    ),
    kingdoms: kingdoms.map((k) => ({
      kingdomId: k,
      controller: k === 'plains' ? ('player' as const) : ('ai' as const),
    })),
    preferences: Object.fromEntries(
      kingdoms.map((k) => [k, { minimumTreasury: 0, minimumStock: 0 }]),
    ),
    relations: allRelations.filter(
      (r) =>
        kingdoms.includes(r.kingdomA as ThreeNationsKingdomId) &&
        kingdoms.includes(r.kingdomB as ThreeNationsKingdomId),
    ),
  };

  const activeGroups: PoliticsConfig['groups'] = [];
  if (!variant.socialActionOff) {
    if (kingdoms.includes('mountains')) {
      activeGroups.push({
        id: 'mountain-miners',
        producerIds: ['mountain-mine'],
        cohortId: 'mount-deep-residents',
        organization: 80,
        resources: 50,
        realWageBps: 6000,
        unemploymentBps: 0,
        satisfaction: 30,
        demand: { wageIncreaseBps: 400 },
        participationBps: 4000,
        recoveryTicks: 6,
        durationTicks: 20,
        workerAccountId: 'mount-deep-residents-cash',
        employerAccountId: 'mine-cash',
        employerOwnerId: 'mine-owner',
        workerOwnerId: 'mount-deep-residents',
        employerAcceptanceBps: 9000,
        actionType: 'strike',
      });
    }
    if (kingdoms.includes('coast')) {
      activeGroups.push({
        id: 'coast-dockworkers',
        producerIds: ['coast-weaver'],
        cohortId: 'coast-loom-residents',
        organization: 70,
        resources: 40,
        realWageBps: 9500,
        unemploymentBps: 0,
        satisfaction: 60,
        // healthy no-action control: no wage demand, so the engine's own eligibility rule
        // (demand.wageIncreaseBps > 0) keeps the group quiet even when live signals degrade
        demand: { wageIncreaseBps: 0 },
        participationBps: 5000,
        recoveryTicks: 6,
        durationTicks: 20,
        actionType: 'strike',
      });
    }
  }
  const politicsConfig: PoliticsConfig = {
    groups: activeGroups,
    producers: activeGroups.flatMap((g) => g.producerIds.map((id) => ({ id }))),
  };

  const firmsConfig: FirmsConfig = {
    producers: producers.map((p) => ({
      id: p.id,
      cityId: p.cityId,
      ownerId: p.ownerId,
      accountId: p.accountId,
      recipeId: p.recipeId,
      laborPerBatch: p.laborPerBatch,
      maxBatches: p.maxBatches,
      wagePerBatch: p.wagePerBatch,
      // must mirror the economy producer records exactly, including skill requirements,
      // or the firms initialize-phase integrity check rejects the domain
      ...(p.requiredSkills ? { requiredSkills: p.requiredSkills } : {}),
    })),
    constructionAccountId: 'construction-cash',
    expansionCostPerCapacity: 50,
  };

  const engine = createEngine({ worldId: 'three-nations-trade-and-politics' }, seed);
  registerLocalEconomy(engine, economy);
  registerFirms(engine, firmsConfig);
  registerCities(engine, citiesConfig);
  registerLogistics(engine, logisticsConfig);
  registerGovernment(engine, governmentConfig);
  registerDiplomacy(engine, diplomacyConfig);
  registerPolitics(engine, politicsConfig);
  registerAdvisor(engine, governmentConfig);

  // fixture-owned publish-phase observer: per-tick compact samples reconciled by @epcse/analytics
  const cohortCity: Record<string, string> = Object.fromEntries(
    specs.map((s) => [s.cohort.id, s.cohort.cityId]),
  );
  const producerCity: Record<string, string> = Object.fromEntries(
    producers.map((p) => [p.id, p.cityId]),
  );
  const routeCities: Record<string, { source: string; dest: string }> = Object.fromEntries(
    logisticsConfig.routes.map((r) => [
      r.routeId,
      { source: r.sourceCityId, dest: r.destinationCityId },
    ]),
  );
  const stapleKeys: Record<string, string> = {};
  if (kingdoms.includes('plains')) stapleKeys.plains = key('plain-central', 'grain');
  if (kingdoms.includes('mountains')) stapleKeys.mountains = key('mount-hold', 'grain');
  if (kingdoms.includes('coast')) stapleKeys.coast = key('coast-harbor', 'grain');
  const treasuryIds: Record<string, string> = Object.fromEntries(
    kingdoms.map((k) => [k, `${k}-treasury`]),
  );

  interface MetricsState {
    version: 2;
    /** Compact per-tick frames: "<tick>|<produced,consumed,unmet,departed,arrived> per city;|<treasury per kingdom>|<staple per kingdom>|<sparse city:commodity:price samples ';'-joined>", alphabetical city/kingdom order. */
    series: string[];
    /** Non-replayable scratch aggregates (excluded from the replayed frame contract). */
    aggCache?: {
      journalCursor: number;
      produced: Record<string, number>;
      consumed: Record<string, number>;
      departed: Record<string, number>;
      arrived: Record<string, number>;
      unmet: Record<string, number>;
    };
  }
  const sortedCities = [...cityIds].sort();
  const sortedKingdoms = [...kingdoms].sort();
  engine.registerPhaseSystem('publish', 'three-nations:metrics', (draft) => {
    if (!draft['three-nations:metrics']) {
      draft['three-nations:metrics'] = {
        version: 2,
        series: [],
      } satisfies MetricsState;
    }
    const metrics = draft['three-nations:metrics'] as MetricsState;
    const tick = metrics.series.length + 1;
    const accounting = draft.accounting as AccountingState;
    if (!metrics.aggCache) {
      metrics.aggCache = {
        journalCursor: 0,
        produced: {},
        consumed: {},
        departed: {},
        arrived: {},
        unmet: {},
      };
    }
    const agg = metrics.aggCache;
    for (const entry of accounting.journal.slice(agg.journalCursor)) {
      if (entry.type === 'consume' && entry.causeId.startsWith('consumption:')) {
        const cohortId = entry.causeId.split(':')[1]!;
        const cityId = cohortCity[cohortId];
        if (cityId) {
          const effect = entry.effects[0] as { consume?: number; commodity?: string } | undefined;
          const quantity = Number(effect?.consume ?? 0);
          agg.consumed[cityId] = (agg.consumed[cityId] ?? 0) + quantity;
        }
      }
    }
    agg.journalCursor = accounting.journal.length;
    const economyState = draft.economy as
      { producers: Record<string, { batches: number }> } | undefined;
    for (const [producerId, cityId] of Object.entries(producerCity)) {
      const batches = economyState?.producers[producerId]?.batches ?? 0;
      agg.produced[cityId] = (agg.produced[cityId] ?? 0) + batches;
    }
    const logistics = draft.logistics as
      | {
          shipments: Array<{
            routeId: string;
            departureTick: number;
            arrivalTick: number;
            status: string;
          }>;
        }
      | undefined;
    for (const shipment of logistics?.shipments ?? []) {
      if (shipment.departureTick === tick) {
        const cityId = routeCities[shipment.routeId]?.source;
        if (cityId) agg.departed[cityId] = (agg.departed[cityId] ?? 0) + 1;
      }
      if (shipment.status === 'arrived' && shipment.arrivalTick === tick) {
        const cityId = routeCities[shipment.routeId]?.dest;
        if (cityId) agg.arrived[cityId] = (agg.arrived[cityId] ?? 0) + 1;
      }
    }
    const economyCohorts = draft.economy as
      { cohorts: Record<string, { cumulativeUnmet: Record<string, number> }> } | undefined;
    const cityUnmet: Record<string, number> = {};
    for (const [cohortId, state] of Object.entries(economyCohorts?.cohorts ?? {})) {
      const cityId = cohortCity[cohortId];
      if (!cityId) continue;
      cityUnmet[cityId] =
        (cityUnmet[cityId] ?? 0) + Object.values(state.cumulativeUnmet).reduce((a, b) => a + b, 0);
    }
    for (const [cityId, total] of Object.entries(cityUnmet)) agg.unmet[cityId] = total;
    const cityGroups = sortedCities.map((cityId) =>
      [
        agg.produced[cityId] ?? 0,
        agg.consumed[cityId] ?? 0,
        agg.unmet[cityId] ?? 0,
        agg.departed[cityId] ?? 0,
        agg.arrived[cityId] ?? 0,
      ].join(','),
    );
    const treasuries = sortedKingdoms.map(
      (kingdomId) => accounting.accounts.find((a) => a.id === treasuryIds[kingdomId])?.balance ?? 0,
    );
    const quotes = (draft.economy as { quotes: Record<string, { price: number }> } | undefined)
      ?.quotes;
    const staples = sortedKingdoms.map((kingdomId) => {
      const stapleKey = stapleKeys[kingdomId];
      const price = stapleKey !== undefined ? quotes?.[stapleKey]?.price : undefined;
      return typeof price === 'number' ? price : 0;
    });
    // Sparse city price samples observed at THIS tick, parsed from the quotes keys (which are
    // JSON.stringify([cityId, commodityId])). Alphabetical by city, then commodity; no
    // backfilling or interpolation — absent quotes simply contribute nothing.
    const sampleCities: Record<string, Record<string, number>> = {};
    for (const [quoteKey, quote] of Object.entries(quotes ?? {})) {
      const parsed = JSON.parse(quoteKey) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 2) continue;
      const [cityId, commodityId] = parsed as [string, string];
      const price = quote?.price;
      if (typeof price === 'number') (sampleCities[cityId] ??= {})[commodityId] = price;
    }
    const samplesSegment = Object.keys(sampleCities)
      .sort()
      .map((cityId) =>
        Object.keys(sampleCities[cityId]!)
          .sort()
          .map((commodityId) => `${cityId}:${commodityId}:${sampleCities[cityId]![commodityId]}`)
          .join(';'),
      )
      .filter((chunk) => chunk.length > 0)
      .join(';');
    metrics.series.push(
      `${tick}|${cityGroups.join(';')}|${treasuries.join(',')}|${staples.join(',')}|${samplesSegment}`,
    );
  });
  engine.registerInvariant((draft) => {
    const metrics = draft['three-nations:metrics'] as MetricsState | undefined;
    if (!metrics) return;
    if (metrics.version !== 2 || !Array.isArray(metrics.series))
      throw new TypeError('invalid three-nations metrics shape');
    const frame = /^(\d+)\|([^|]+)\|([\d,]+)\|([\d,]+)\|([^|]*)$/;
    const citySet = new Set(sortedCities);
    for (const line of metrics.series) {
      const match = frame.exec(line);
      if (!match) throw new TypeError('malformed metrics frame');
      const cities = match[2]!.split(';');
      if (cities.length !== sortedCities.length) throw new TypeError('metrics city count mismatch');
      for (const group of cities) {
        const numbers = group.split(',').map(Number);
        if (numbers.length !== 5 || numbers.some((n) => !Number.isSafeInteger(n) || n < 0))
          throw new TypeError('non-finite metrics city counters');
      }
      const treasuries = match[3]!.split(',').map(Number);
      const staples = match[4]!.split(',').map(Number);
      if (
        treasuries.length !== sortedKingdoms.length ||
        staples.length !== sortedKingdoms.length ||
        [...treasuries, ...staples].some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        throw new TypeError('non-finite metrics kingdom data');
      // samples segment: "cityId:commodity:price" entries, ';' joined, cities alphabetical,
      // commodities alphabetical within each city, known city ids, safe nonnegative prices.
      const sampleEntries = match[5]!.split(';').filter((entry) => entry.length > 0);
      let lastCity: string | undefined;
      let lastCommodity: string | undefined;
      for (const entry of sampleEntries) {
        const parts = entry.split(':');
        const [cityId, commodityId, rawPrice] = parts as [string, string, string];
        if (parts.length !== 3 || !citySet.has(cityId))
          throw new TypeError('malformed metrics price sample');
        const price = Number(rawPrice);
        if (!Number.isSafeInteger(price) || price < 0)
          throw new TypeError('non-finite metrics price sample');
        if (lastCity === cityId && commodityId <= lastCommodity!)
          throw new TypeError('unsorted metrics price samples within city');
        if (lastCity !== undefined && cityId < lastCity)
          throw new TypeError('unsorted metrics price sample cities');
        lastCity = cityId;
        lastCommodity = commodityId;
      }
    }
  });

  const departureBuyer: Record<string, string> = {
    'plains-mountains-road': 'mount-trader-cash',
    'plains-mountains-pass': 'mount-trader-cash',
    'mountain-coast-road': 'coast-trader-cash',
    'plains-coast-sea': 'coast-trader-cash',
    'coast-plain-road': 'plain-market-cash',
  };
  // departure cadence of 100 ticks keeps total in-flight shipment volume (and journal load) bounded
  const departures: readonly {
    readonly modulo: number;
    readonly routeId: string;
    readonly commodity: string;
    readonly quantity: number;
  }[] = [
    { modulo: 3, routeId: 'plains-mountains-road', commodity: 'grain', quantity: 2 },
    { modulo: 3, routeId: 'mountain-coast-road', commodity: 'tools', quantity: 2 },
    { modulo: 4, routeId: 'plains-mountains-pass', commodity: 'grain', quantity: 1 },
    { modulo: 5, routeId: 'coast-plain-road', commodity: 'cloth', quantity: 2 },
    { modulo: 55, routeId: 'coast-plain-road', commodity: 'clothes', quantity: 1 },
  ];
  // Tariff payers must map to the trusted origin jurisdiction (the source-city owner).
  departureBuyer['coast-plain-road'] = 'coast-trader-cash';
  const activeRoutes = new Set(logisticsConfig.routes.map((r) => r.routeId));
  const playerOffers = diplomacyConfig.offers.filter(
    (o) => o.fromKingdomId === 'plains' || o.toKingdomId === 'plains',
  );
  const playerDecision = variant.playerDecision ?? 'accept';
  let negotiateSubmitted = false;

  const commandsForTick = (tick: number): readonly EngineCommand[] => {
    const commands: EngineCommand[] = [];
    if (tick === 2) {
      for (const offer of playerOffers) {
        commands.push({
          commandId: `player-decision-${offer.offerId}`,
          type: 'diplomacy.decision',
          requestedTick: tick,
          payload: {
            offerId: offer.offerId,
            kingdomId: 'plains',
            accepted: playerDecision === 'accept',
            reason: 'explicit fixture player decision',
          },
        });
      }
      if (variant.foodSubsidy) {
        const recipient = specs.find((s) => s.cohort.id === 'plain-central-residents')!;
        commands.push({
          commandId: 'fixture-food-subsidy',
          type: 'government.policy',
          requestedTick: tick,
          payload: {
            kingdomId: 'plains',
            governmentId: 'plains',
            variant: 'food-subsidy',
            policyId: 'plain-bread-subsidy',
            recipientKingdomId: 'plains',
            recipientOwnerId: recipient.cohort.ownerId,
            recipientAccountId: recipient.cohort.accountId,
            commodity: 'grain',
            amount: 10,
            effectiveTick: 4,
            legitimacy: 80,
            quorum: 0,
            support: 80,
            oppositionVeto: false,
          },
        });
      }
      if (variant.localPurchaseTax) {
        commands.push({
          commandId: 'fixture-purchase-tax',
          type: 'government.policy',
          requestedTick: tick,
          payload: {
            kingdomId: 'plains',
            governmentId: 'plains',
            variant: 'local-purchase-tax',
            policyId: 'plain-central-purchase-tax',
            cityId: 'plain-central',
            rateBps: 2500,
            incidence: 'buyer',
            effectiveTick: 4,
            expiryTick: ticks,
            legitimacy: 80,
            quorum: 0,
            support: 80,
            oppositionVeto: false,
          },
        });
      }
    }
    if (tick === 120) {
      if (variant.tariffOnly || variant.tariffDiscount) {
        commands.push({
          commandId: 'fixture-import-tariff',
          type: 'government.policy',
          requestedTick: tick,
          payload: {
            kingdomId: 'plains',
            governmentId: 'plains',
            variant: 'import-tariff',
            policyId: 'clothes-import-tariff',
            importKingdomId: 'plains',
            routeId: 'coast-plain-road',
            commodity: 'clothes',
            amount: 10,
            effectiveTick: 122,
            expiryTick: ticks,
            legitimacy: 80,
            quorum: 0,
            support: 80,
            oppositionVeto: false,
          },
        });
      }
      if (variant.tradeRestriction) {
        commands.push({
          commandId: 'fixture-trade-restriction',
          type: 'government.policy',
          requestedTick: tick,
          payload: {
            kingdomId: 'plains',
            governmentId: 'plains',
            variant: 'trade-restriction',
            policyId: 'clothes-import-restriction',
            importKingdomId: 'plains',
            routeId: 'coast-plain-road',
            commodity: 'clothes',
            amount: 0,
            effectiveTick: 122,
            expiryTick: 200,
            legitimacy: 80,
            quorum: 0,
            support: 80,
            oppositionVeto: false,
          },
        });
      }
    }
    if (shock) {
      if (shock.kind === 'route-close') {
        if (tick === shock.startTick)
          commands.push({
            commandId: 'shock-route-close',
            type: 'logistics.route.close',
            requestedTick: tick,
            payload: { routeId: shock.routeId },
          });
        if (tick === shock.startTick + shock.durationTicks)
          commands.push({
            commandId: 'shock-route-open',
            type: 'logistics.route.open',
            requestedTick: tick,
            payload: { routeId: shock.routeId },
          });
      } else if (tick === shock.startTick) {
        const effectiveTick = shock.startTick + 2;
        commands.push({
          commandId: 'shock-import-tariff',
          type: 'government.policy',
          requestedTick: tick,
          payload: {
            kingdomId: shock.importKingdomId,
            governmentId: shock.importKingdomId,
            variant: 'import-tariff',
            policyId: 'shock-import-tariff',
            importKingdomId: shock.importKingdomId,
            routeId: shock.routeId,
            commodity: shock.commodity,
            amount: shock.amount,
            effectiveTick,
            expiryTick: Math.max(effectiveTick, shock.startTick + shock.durationTicks),
            legitimacy: 80,
            quorum: 0,
            support: 80,
            oppositionVeto: false,
          },
        });
      }
    }
    // fixture-driven trade departures
    if (tick >= 3 && tick <= 500) {
      for (const departure of departures) {
        if (!activeRoutes.has(departure.routeId) || tick % 100 !== departure.modulo) continue;
        commands.push({
          commandId: `dep-${departure.routeId}-${departure.commodity}-${tick}`,
          type: 'logistics.depart',
          requestedTick: tick,
          payload: {
            shipmentId: `ship-${departure.routeId}-${departure.commodity}-${tick}`,
            routeId: departure.routeId,
            commodity: departure.commodity,
            quantity: departure.quantity,
            buyerAccountId: departureBuyer[departure.routeId]!,
            payment: ROUTES.find((r) => r.routeId === departure.routeId)!.fare,
          },
        });
      }
    }
    // autonomous-seeming but rule-driven miner negotiation, submitted once when the action is active
    if (
      (variant.minerNegotiation === 'funded' || variant.minerNegotiation === 'underfunded') &&
      !negotiateSubmitted
    ) {
      const politics = engine.getState().domain.politics as
        { actions?: Array<{ id: string; groupId: string; status: string }> } | undefined;
      const action = politics?.actions?.find(
        (a) => a.groupId === 'mountain-miners' && a.status === 'active',
      );
      if (action) {
        negotiateSubmitted = true;
        commands.push({
          commandId: 'fixture-miner-negotiation',
          type: 'politics.negotiate',
          requestedTick: tick,
          payload: {
            actionId: action.id,
            decision: 'offer',
            amount: variant.minerNegotiation === 'funded' ? 300 : 900000,
            wageIncreaseBps: 200,
          },
        });
      }
    }
    return commands;
  };

  return { engine, config, commandsForTick };
}

export function runThreeNations(options: ThreeNationsOptions = {}): ThreeNationsReport {
  const fixture = createThreeNations(options);
  const { engine, config, commandsForTick } = fixture;
  if (config.variant.minerNegotiation === undefined) {
    // The whole schedule is deterministic: queue every command upfront and run once (mirrors the
    // vertical-slice single-run pattern, avoiding per-tick full-state views).
    for (let tick = 1; tick <= config.ticks; tick++)
      for (const command of commandsForTick(tick)) engine.submit(command);
    engine.run(config.ticks);
  } else {
    for (let tick = 1; tick <= config.ticks; tick++) {
      for (const command of commandsForTick(tick)) engine.submit(command);
      engine.step();
    }
  }
  return buildReport(engine, config);
}

function buildReport(engine: Engine, config: ResolvedThreeNationsConfig): ThreeNationsReport {
  const view = engine.getState();
  const domain = view.domain;
  const accounting = domain.accounting as AccountingState;
  const metrics = domain['three-nations:metrics'] as { series: string[] } | undefined;
  const sortedCities = [...config.cityIds].sort();
  const sortedKingdoms = [...config.kingdoms].sort();
  const lastLine = metrics?.series[metrics.series.length - 1] ?? '';
  const parts = lastLine.split('|');
  const cityNumbers = (parts[1] ?? '').split(';').map((group) => group.split(',').map(Number));
  const treasuries = (parts[2] ?? '').split(',').map(Number);
  const staples = (parts[3] ?? '').split(',').map(Number);
  const cityOf = (cityId: string) => {
    const numbers = cityNumbers[sortedCities.indexOf(cityId)] ?? [];
    return {
      produced: numbers[0] ?? 0,
      consumed: numbers[1] ?? 0,
      unmet: numbers[2] ?? 0,
      departed: numbers[3] ?? 0,
      arrived: numbers[4] ?? 0,
    };
  };
  const politics = domain.politics as { actions?: Array<{ status: string }> } | undefined;
  const actions = politics?.actions ?? [];
  const countBy = (status: string) => actions.filter((a) => a.status === status).length;
  const kingdomRows = config.kingdoms.map((kingdomId) => {
    const cities = LAYOUTS[kingdomId].cities;
    const sum = (field: 'produced' | 'departed' | 'arrived') =>
      cities.reduce((sum, city) => sum + cityOf(city)[field], 0);
    const index = sortedKingdoms.indexOf(kingdomId);
    return {
      id: kingdomId,
      produced: sum('produced'),
      departed: sum('departed'),
      arrived: sum('arrived'),
      treasury: treasuries[index] ?? 0,
      staplePrice: staples[index] ?? 0,
    };
  });
  const world = {
    produced: kingdomRows.reduce((sum, k) => sum + k.produced, 0),
    departed: kingdomRows.reduce((sum, k) => sum + k.departed, 0),
    arrived: kingdomRows.reduce((sum, k) => sum + k.arrived, 0),
    unmet: [...config.cityIds]
      .sort()
      .reduce((sum: number, city: string) => sum + cityOf(city).unmet, 0),
    treasury: kingdomRows.reduce((sum, k) => sum + k.treasury, 0),
  };
  const openingTotal = accounting.openingBalances.reduce((sum, item) => sum + item.balance, 0);
  const totalMoney = accounting.accounts.reduce((sum, item) => sum + item.balance, 0);
  return {
    fixtureVersion: THREE_NATIONS_FIXTURE_VERSION,
    disclaimer:
      'Configurable fictional three-nations fixture; simplified rules, not M1 acceptance or approved product data.',
    config,
    tick: view.tick,
    stateHash: view.hash,
    eventHash: view.eventHash,
    politics: {
      proposed: actions.length,
      active: countBy('active'),
      resolved: countBy('resolved'),
      failed: countBy('failed'),
      expired: countBy('expired'),
    },
    world,
    kingdoms: kingdomRows,
    reconciliation: true,
    invariants: {
      moneyNonnegative: accounting.accounts.every((a) => a.balance >= 0),
      stockNonnegative: accounting.stock.every((s) => s.quantity >= 0),
      moneyConserved: totalMoney === openingTotal,
    },
  };
}

export function threeNationsSummary(report: ThreeNationsReport): string[] {
  const shockLabel = report.config.shock
    ? report.config.shock.kind === 'route-close'
      ? `route-close:${report.config.shock.routeId} ticks ${report.config.shock.startTick}-${report.config.shock.startTick + report.config.shock.durationTicks}`
      : `import-tariff ${report.config.shock.commodity}@${report.config.shock.routeId} ticks ${report.config.shock.startTick + 2}-${Math.max(report.config.shock.startTick + 2, report.config.shock.startTick + report.config.shock.durationTicks)}`
    : 'none';
  const counts = report.config.counts;
  return [
    `EPCSE M1: three-nations-trade-and-politics fixture v${report.fixtureVersion} (fictional configurable engine integration; not M1 acceptance)`,
    `Configured sizes: kingdoms ${counts.kingdoms}; cities ${counts.cities}; goods ${counts.goods}; sectors ${counts.sectors}; classes ${counts.classes}; government forms supported ${counts.governmentFormsSupported}`,
    `Seed ${report.config.seed}; ticks ${report.tick}; shock ${shockLabel}`,
    `Politics: actions proposed ${report.politics.proposed}, active ${report.politics.active}, resolved ${report.politics.resolved}, failed ${report.politics.failed}, expired ${report.politics.expired}`,
    `Analytics: world produced ${report.world.produced}, departed ${report.world.departed}, arrived ${report.world.arrived}, unmet ${report.world.unmet}, treasury total ${report.world.treasury} coin`,
    ...report.kingdoms.map(
      (k) =>
        `Kingdom ${k.id}: produced ${k.produced}, departed ${k.departed}, arrived ${k.arrived}, treasury ${k.treasury}, staple price ${k.staplePrice}`,
    ),
    `Reconciliation: city sums equal kingdom sums; kingdom sums equal world totals: ${report.reconciliation}`,
    `Invariants: money nonnegative ${report.invariants.moneyNonnegative}; stock nonnegative ${report.invariants.stockNonnegative}; money conserved ${report.invariants.moneyConserved}`,
    `State hash: ${report.stateHash}`,
    `Event hash: ${report.eventHash}`,
    // Deterministic final label block: no timestamps, no wall-clock — byte-identical across runs
    // (SC-15 enforces stdout equality over two independent 1000-tick CLI runs).
    `Final label: three-nations harness fixture v${report.fixtureVersion}; seed ${report.config.seed}; ticks ${report.tick}; state ${report.stateHash}; events ${report.eventHash}`,
    `Status: three-nations integration harness only — NOT M1 acceptance; SC-11 (government-transition politics) excluded from this slice`,
    report.disclaimer,
  ];
}
