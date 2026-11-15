import type { Engine } from '../engine.js';
import { applyAccountingTransaction, type AccountingState } from '../accounting/index.js';
import { hash } from '../../shared/canonical.js';

export interface CityDefinition {
  id: string;
  serviceCapacity: Record<string, number>;
  /** Per-tick upkeep; zero means capacity is pre-funded/installed, not free construction. */
  serviceProvisionCost: number;
  serviceAccountId?: string;
  serviceProviderAccountId?: string;
}
export interface CityCohortDefinition {
  id: string;
  cityId: string;
  population: number;
  category: string;
  class: string;
  skills: Record<string, number>;
  needs: Record<string, number>;
  incomePerPerson: number;
  serviceNeeds: Record<string, number>;
  welfare: number;
  linkedEconomyCohortId: string;
}
export interface CityRoute {
  fromCityId: string;
  toCityId: string;
  costPerPerson: number;
}
export interface CityConfig {
  cities: CityDefinition[];
  cohorts: CityCohortDefinition[];
  routes: CityRoute[];
  carrierAccountId: string;
  migrationFundingAccountId: string;
  migrationBudget: number;
  /** Percentage weights; absent categories/classes use neutral 100. */
  categoryNeedWeights?: Record<string, number>;
  classNeedWeights?: Record<string, number>;
}
export interface CityCohortState extends CityCohortDefinition {
  employment: number;
  unemployment: number;
  incomeThisTick: number;
  dynamicNeeds: Record<string, number>;
  serviceCoverage: Record<string, number>;
}
export interface CityState {
  version: 1;
  configDigest: string;
  cities: Record<string, CityDefinition>;
  cohorts: Record<string, CityCohortState>;
  migrationBudgetRemaining: number;
  serviceFundedThisTick: string[];
  migration: Array<{
    fromCohortId: string;
    toCohortId: string;
    fromCityId: string;
    toCityId: string;
    population: number;
    cost: number;
    tick: number;
  }>;
}
const validCount = (n: number, name: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`invalid ${name}`);
};
const safe = (v: bigint, name: string) => {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} overflow`);
  return Number(v);
};
const account = (a: AccountingState, id: string) => {
  const found = a.accounts.find((x) => x.id === id);
  if (!found) throw new RangeError(`unknown account ${id}`);
  return found;
};
const percentMap = (map: Record<string, number> | undefined, name: string) => {
  for (const [key, value] of Object.entries(map ?? {})) {
    if (!key.trim() || !Number.isSafeInteger(value) || value < 0 || value > 1000)
      throw new RangeError(`invalid ${name} weight`);
  }
};

export function registerCities(engine: Engine, config: CityConfig): void {
  const cities = structuredClone(config.cities),
    cohorts = structuredClone(config.cohorts),
    routes = structuredClone(config.routes);
  const unique = (values: string[], name: string) => {
    if (values.some((x) => !x.trim()) || new Set(values).size !== values.length)
      throw new TypeError(`invalid or duplicate ${name}`);
  };
  unique(
    cities.map((x) => x.id),
    'city ID',
  );
  unique(
    cohorts.map((x) => x.id),
    'cohort ID',
  );
  const cityIds = new Set(cities.map((x) => x.id));
  validCount(config.migrationBudget, 'migration budget');
  percentMap(config.categoryNeedWeights, 'category');
  percentMap(config.classNeedWeights, 'class');
  for (const c of cities) {
    if (!c.id.trim() || !Number.isSafeInteger(c.serviceProvisionCost) || c.serviceProvisionCost < 0)
      throw new RangeError('invalid city service configuration');
    for (const [service, n] of Object.entries(c.serviceCapacity)) {
      if (!service.trim()) throw new TypeError('invalid service category');
      validCount(n, 'service capacity');
    }
    if (
      c.serviceProvisionCost > 0 &&
      (!c.serviceAccountId ||
        !c.serviceProviderAccountId ||
        c.serviceAccountId === c.serviceProviderAccountId)
    )
      throw new TypeError('funded service requires distinct payer and provider accounts');
  }
  for (const c of cohorts) {
    if (
      !c.id.trim() ||
      !cityIds.has(c.cityId) ||
      !c.category.trim() ||
      !c.class.trim() ||
      !c.linkedEconomyCohortId
    )
      throw new TypeError('invalid city cohort binding');
    validCount(c.population, 'population');
    validCount(c.incomePerPerson, 'income');
    validCount(c.welfare, 'welfare');
    for (const [skill, n] of Object.entries(c.skills)) {
      if (!skill.trim()) throw new TypeError('invalid skill');
      validCount(n, 'skill level');
    }
    for (const values of [c.needs, c.serviceNeeds]) {
      for (const [key, n] of Object.entries(values)) {
        if (!key.trim()) throw new TypeError('invalid need category');
        validCount(n, 'cohort value');
      }
    }
  }
  unique(
    routes.map((r) => `${r.fromCityId}\0${r.toCityId}`),
    'route',
  );
  for (const r of routes)
    if (
      !cityIds.has(r.fromCityId) ||
      !cityIds.has(r.toCityId) ||
      r.fromCityId === r.toCityId ||
      !Number.isSafeInteger(r.costPerPerson) ||
      r.costPerPerson < 0
    )
      throw new TypeError('invalid city route');
  if (new Set(cohorts.map((c) => c.linkedEconomyCohortId)).size !== cohorts.length)
    throw new TypeError('city cohorts must bind distinct economy cohorts');
  if (
    cohorts.some(
      (c) => config.categoryNeedWeights && !(c.category in config.categoryNeedWeights),
    ) ||
    cohorts.some((c) => config.classNeedWeights && !(c.class in config.classNeedWeights))
  )
    throw new TypeError('every configured cohort category/class requires an explicit need weight');
  const configDigest = hash(config);
  const initialPopulation = cohorts.reduce((sum, cohort) => sum + BigInt(cohort.population), 0n);
  const state: CityState = {
    version: 1,
    configDigest,
    cities: Object.fromEntries(cities.map((x) => [x.id, x])),
    cohorts: Object.fromEntries(
      cohorts.map((x) => [
        x.id,
        {
          ...x,
          employment: 0,
          unemployment: x.population,
          incomeThisTick: 0,
          dynamicNeeds: {},
          serviceCoverage: {},
        },
      ]),
    ),
    migrationBudgetRemaining: config.migrationBudget,
    serviceFundedThisTick: [],
    migration: [],
  };
  engine.registerPhaseSystem('infrastructure', 'zz-cities:initialize', (draft) => {
    if (draft.cities !== undefined) {
      if ((draft.cities as CityState).configDigest !== configDigest)
        throw new Error('city config mismatch');
      return;
    }
    const economyState = draft.economy as
      | {
          cohorts: Record<string, { unmet: Record<string, number> }>;
          configCohorts: Record<string, { cityId: string }>;
        }
      | undefined;
    const economyCohorts = economyState?.cohorts;
    const ledger = draft.accounting as AccountingState | undefined;
    if (
      !economyCohorts ||
      cohorts.some(
        (c) =>
          !economyCohorts[c.linkedEconomyCohortId] ||
          economyState?.configCohorts[c.linkedEconomyCohortId]?.cityId !== c.cityId ||
          Object.keys(economyCohorts[c.linkedEconomyCohortId]!.unmet).sort().join('\0') !==
            Object.keys(c.needs).sort().join('\0'),
      ) ||
      !ledger
    )
      throw new RangeError('invalid city/economy binding or needs schema');
    const carrier = account(ledger, config.carrierAccountId),
      fund = account(ledger, config.migrationFundingAccountId);
    if (carrier.ownerId === fund.ownerId)
      throw new TypeError('migration self-payment is not allowed');
    for (const city of cities)
      if (city.serviceProvisionCost) {
        const payer = account(ledger, city.serviceAccountId!),
          provider = account(ledger, city.serviceProviderAccountId!);
        if (payer.ownerId === provider.ownerId)
          throw new TypeError('city service self-payment is not allowed');
      }
    draft.cities = structuredClone(state);
  });
  engine.registerInvariant((d) => {
    const s = d.cities as CityState | undefined;
    if (!s) return;
    if (s.version !== 1 || s.configDigest !== configDigest || !s.cohorts || !s.cities)
      throw new TypeError('invalid city state');
    for (const c of Object.values(s.cohorts)) {
      validCount(c.population, 'population');
      validCount(c.employment, 'employment');
      validCount(c.unemployment, 'unemployment');
      validCount(c.incomeThisTick, 'cohort income');
      if (c.employment + c.unemployment !== c.population)
        throw new RangeError('cohort employment conservation violated');
      Object.values(c.dynamicNeeds).forEach((n) => validCount(n, 'dynamic need'));
    }
    if (
      Object.values(s.cohorts).reduce((sum, cohort) => sum + BigInt(cohort.population), 0n) !==
        initialPopulation ||
      s.migrationBudgetRemaining < 0 ||
      s.migrationBudgetRemaining > config.migrationBudget
    )
      throw new RangeError('city population or migration budget conservation violated');
  });
  engine.registerPhaseSystem('workforce', 'cities:services-and-needs', (draft) => {
    const s = draft.cities as CityState;
    let a = draft.accounting as AccountingState;
    const funded = new Set<string>();
    for (const city of Object.values(s.cities)) {
      if (city.serviceProvisionCost === 0) {
        funded.add(city.id);
        continue;
      }
      const payer = account(a, city.serviceAccountId!);
      if (payer.balance < city.serviceProvisionCost) continue;
      a = applyAccountingTransaction(
        a,
        [
          {
            type: 'payment',
            fromAccountId: city.serviceAccountId!,
            toAccountId: city.serviceProviderAccountId!,
            amount: {
              kind: 'money',
              currencyId: a.currency.id,
              unit: a.currency.unit,
              scale: a.currency.scale,
              minor: city.serviceProvisionCost,
            },
            causeId: `city-service:${city.id}`,
          },
        ],
        `city-service:${engine.getState().tick + 1}:${city.id}`,
      );
      funded.add(city.id);
    }
    s.serviceFundedThisTick = [...funded];
    draft.accounting = a;
    for (const city of Object.values(s.cities)) {
      const residents = Object.values(s.cohorts)
        .filter((c) => c.cityId === city.id)
        .sort((x, y) => x.id.localeCompare(y.id));
      const remaining = new Map(
        Object.entries(funded.has(city.id) ? city.serviceCapacity : {}).map(([k, n]) => [k, n]),
      );
      for (const c of residents) {
        c.serviceCoverage = Object.fromEntries(
          Object.entries(c.serviceNeeds).map(([service, need]) => {
            const required = BigInt(need) * BigInt(c.population),
              available = BigInt(remaining.get(service) ?? 0);
            const allocated = required < available ? required : available;
            remaining.set(service, Number(available - allocated));
            return [service, required === 0n ? 100 : Number((allocated * 100n) / required)];
          }),
        );
      }
    }
    const economy = draft.economy as {
      sellers: Record<string, { openingPrice: number; price: number }>;
      cohorts: Record<string, { unmet: Record<string, number> }>;
    };
    for (const c of Object.values(s.cohorts)) {
      const coverage = Object.values(c.serviceCoverage);
      const serviceFactor = coverage.length
        ? 100 + Math.floor((100 - coverage.reduce((a, b) => a + b, 0) / coverage.length) / 10)
        : 100;
      const categoryWeight = config.categoryNeedWeights?.[c.category] ?? 100;
      const classWeight = config.classNeedWeights?.[c.class] ?? 100;
      c.dynamicNeeds = Object.fromEntries(
        Object.entries(c.needs).map(([commodity, perPerson]) => {
          const wagePerPerson =
            c.population === 0 ? 0 : Math.floor(c.incomeThisTick / c.population);
          const income = safe(BigInt(c.incomePerPerson) + BigInt(wagePerPerson), 'cohort income');
          const incomeFactor =
            income === 0 ? 100 : Math.max(50, Math.min(150, 100 + Math.floor(income / 10)));
          const market = economy.sellers[JSON.stringify([c.cityId, commodity])];
          const rawPrice = market
            ? 100n -
              (BigInt(market.price - market.openingPrice) * 100n) / BigInt(market.openingPrice) / 4n
            : 100n;
          const priceFactor = Number(rawPrice < 50n ? 50n : rawPrice > 150n ? 150n : rawPrice);
          const shortage = economy.cohorts[c.linkedEconomyCohortId]?.unmet[commodity] ? 110 : 100;
          return [
            commodity,
            safe(
              (BigInt(perPerson) *
                BigInt(c.population) *
                BigInt(categoryWeight) *
                BigInt(classWeight) *
                BigInt(incomeFactor) *
                BigInt(serviceFactor) *
                BigInt(priceFactor) *
                BigInt(shortage)) /
                1000000000000n,
              'cohort need',
            ),
          ];
        }),
      );
    }
  });
  engine.registerPhaseSystem('population', 'cities:migration-and-welfare', (draft) => {
    const s = draft.cities as CityState;
    let a = draft.accounting as AccountingState;
    const economy = draft.economy as { cohorts: Record<string, { unmet: Record<string, number> }> };
    const producers = (
      draft.economy as {
        producers: Record<
          string,
          {
            employed: number;
            cityId: string;
            maxBatches: number;
            laborPerBatch: number;
            requiredSkills: Record<string, number>;
          }
        >;
      }
    ).producers;
    // A matching city with at least one actually vacant skill-eligible worker slot adds 100 utility points; route cost is subtracted in the same integer-point scale.
    const jobUtility = (cityId: string, cohort: CityCohortState): bigint => {
      const slots = Object.values(producers).reduce((sum, producer) => {
        if (
          producer.cityId !== cityId ||
          !Object.entries(producer.requiredSkills).every(
            ([skill, level]) => (cohort.skills[skill] ?? 0) >= level,
          )
        )
          return sum;
        return sum + Math.max(0, producer.maxBatches * producer.laborPerBatch - producer.employed);
      }, 0);
      return slots > 0 && cohort.unemployment > 0 ? 100n : 0n;
    };
    for (const c of Object.values(s.cohorts).sort((x, y) => x.id.localeCompare(y.id))) {
      c.employment = Math.min(c.population, c.employment);
      c.unemployment = c.population - c.employment;
      if (c.population === 0) continue;
      let unmet = 0;
      for (const amount of Object.values(economy.cohorts[c.linkedEconomyCohortId]?.unmet ?? {}))
        unmet = safe(BigInt(unmet) + BigInt(amount), 'unmet needs');
      const coverage = Object.values(c.serviceCoverage);
      c.welfare = Math.max(
        0,
        Math.min(
          100,
          c.welfare +
            (unmet === 0 ? 1 : -Math.min(5, unmet)) +
            (coverage.length
              ? Math.floor(coverage.reduce((x, y) => x + y, 0) / coverage.length / 50) - 1
              : 0),
        ),
      );
      const utility = (cityId: string) => {
        const serviceScore = Object.entries(c.serviceNeeds).reduce((total, [service, need]) => {
          const city = s.cities[cityId]!;
          const serviceFunded = s.serviceFundedThisTick.includes(cityId);
          let capacity = BigInt(serviceFunded ? (city.serviceCapacity[service] ?? 0) : 0);
          for (const resident of Object.values(s.cohorts)
            .filter((x) => x.cityId === cityId && x.id !== c.id)
            .sort((x, y) => x.id.localeCompare(y.id))) {
            const occupied =
              BigInt(resident.serviceNeeds[service] ?? 0) * BigInt(resident.population);
            capacity = capacity > occupied ? capacity - occupied : 0n;
          }
          const required = BigInt(need) * BigInt(c.population);
          const covered = required === 0n ? 100n : (capacity * 100n) / required;
          return total + (covered > 100n ? 100n : covered);
        }, 0n);
        return serviceScore + jobUtility(cityId, c);
      };
      const sourceUtility = utility(c.cityId);
      const candidates = routes
        .filter((r) => r.fromCityId === c.cityId)
        .map((r) => {
          const target = Object.values(s.cohorts).find(
            (candidate) =>
              candidate.cityId === r.toCityId &&
              candidate.category === c.category &&
              candidate.class === c.class &&
              JSON.stringify(candidate.skills) === JSON.stringify(c.skills) &&
              JSON.stringify(candidate.needs) === JSON.stringify(c.needs) &&
              JSON.stringify(candidate.serviceNeeds) === JSON.stringify(c.serviceNeeds),
          );
          return {
            route: r,
            target,
            score: target ? utility(r.toCityId) - sourceUtility - BigInt(r.costPerPerson) : -1n,
          };
        })
        .sort((x, y) =>
          x.score === y.score
            ? x.route.toCityId.localeCompare(y.route.toCityId)
            : x.score > y.score
              ? -1
              : 1,
        );
      const best = candidates[0];
      if (!best || best.score <= 0n || c.unemployment === 0) continue;
      const destination = best.target;
      if (!destination || destination.id === c.id) continue;
      const affordability = Math.min(
        s.migrationBudgetRemaining,
        account(a, config.migrationFundingAccountId).balance,
      );
      const moving = Math.min(c.unemployment, Math.floor(affordability / best.route.costPerPerson));
      // A zero-cost route is explicitly allowed; positive costs are capped by both budget and payer balance.
      const fundedMoving = best.route.costPerPerson === 0 ? c.unemployment : moving;
      if (fundedMoving < 1) continue;
      const cost = safe(BigInt(fundedMoving) * BigInt(best.route.costPerPerson), 'migration cost');
      if (cost > 0)
        a = applyAccountingTransaction(
          a,
          [
            {
              type: 'payment',
              fromAccountId: config.migrationFundingAccountId,
              toAccountId: config.carrierAccountId,
              amount: {
                kind: 'money',
                currencyId: a.currency.id,
                unit: a.currency.unit,
                scale: a.currency.scale,
                minor: cost,
              },
              causeId: `migration:${c.id}:${destination.id}`,
            },
          ],
          `migration:${engine.getState().tick + 1}:${c.id}:${destination.id}`,
        );
      c.population -= fundedMoving;
      c.employment = Math.min(c.employment, c.population);
      c.unemployment = c.population - c.employment;
      destination.population = safe(
        BigInt(destination.population) + BigInt(fundedMoving),
        'destination population',
      );
      destination.unemployment += fundedMoving;
      s.migrationBudgetRemaining -= cost;
      s.migration.push({
        fromCohortId: c.id,
        toCohortId: destination.id,
        fromCityId: best.route.fromCityId,
        toCityId: best.route.toCityId,
        population: fundedMoving,
        cost,
        tick: engine.getState().tick + 1,
      });
    }
    draft.accounting = a;
  });
}
