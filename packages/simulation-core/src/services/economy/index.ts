import type { Engine } from '../engine.js';
import {
  assertAccountingInvariant,
  applyAccountingTransaction,
  createAccountingState,
  type AccountingConfig,
  type AccountingOperation,
  type AccountingState,
} from '../accounting/index.js';
import type { CommodityQuantity, MoneyUnit } from '../../models/units.js';
import { hash } from '../../shared/canonical.js';
import { getPoliticsImpactPlan } from '../politics/index.js';

export interface LocalEconomyProducer {
  id: string;
  cityId: string;
  ownerId: string;
  accountId: string;
  recipeId: string;
  laborPerBatch: number;
  maxBatches: number;
  wagePerBatch: number;
  /** When configured, workers must have at least these skill levels. */
  requiredSkills?: Record<string, number>;
}
export interface LocalEconomyCohort {
  id: string;
  cityId: string;
  ownerId: string;
  accountId: string;
  workersAvailable: number;
  desiredNeeds: Record<string, number>;
}
export interface LocalEconomySeller {
  cityId: string;
  commodity: string;
  ownerId: string;
  accountId: string;
  minPrice: number;
  maxPrice: number;
  openingPrice: number;
}
export interface LocalEconomyConfig extends Omit<AccountingConfig, 'stock'> {
  stock?: AccountingConfig['stock'];
  producers: LocalEconomyProducer[];
  cohorts: LocalEconomyCohort[];
  sellers: LocalEconomySeller[];
}
type EconomyState = {
  version: 1;
  configDigest: string;
  configCohorts: Record<string, { cityId: string; ownerId: string; accountId: string }>;
  producers: Record<
    string,
    {
      id: string;
      stopped: string | null;
      batches: number;
      employed: number;
      cityId: string;
      ownerId: string;
      accountId: string;
      recipeId: string;
      wagePerBatch: number;
      maxBatches: number;
      laborPerBatch: number;
      requiredSkills: Record<string, number>;
    }
  >;
  cohorts: Record<
    string,
    {
      unmet: Record<string, number>;
      cumulativeUnmet: Record<string, number>;
      reasons: Record<string, string>;
    }
  >;
  sellers: Record<string, LocalEconomySeller & { price: number; reason: string }>;
  quotes: Record<string, { price: number; reason: string }>;
};
const MAX_BATCHES = 1000;
const key = (city: string, commodity: string) => JSON.stringify([city, commodity]);
const checkedNumber = (value: bigint, name: string): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`${name} overflow`);
  return Number(value);
};
const count = (x: number, name: string, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(x) || x < 0 || x > max)
    throw new RangeError(`${name} must be a bounded nonnegative safe integer`);
};
function money(state: AccountingState, minor: number): MoneyUnit {
  return {
    kind: 'money',
    currencyId: state.currency.id,
    unit: state.currency.unit,
    scale: state.currency.scale,
    minor,
  };
}
function quantity(state: AccountingState, commodityId: string, value: number): CommodityQuantity {
  const c = state.commodities.find((x) => x.id === commodityId)!;
  return { kind: 'commodity', commodityId, unit: c.unit, scale: c.scale, quantity: value };
}
function account(state: AccountingState, id: string) {
  const found = state.accounts.find((x) => x.id === id);
  if (!found) throw new RangeError(`unknown account ${id}`);
  return found;
}
function liveCohort(draft: Record<string, unknown>, cohort: LocalEconomyCohort) {
  const cities = draft.cities as
    | {
        cohorts?: Record<
          string,
          {
            linkedEconomyCohortId: string;
            population: number;
            cityId: string;
            dynamicNeeds: Record<string, number>;
          }
        >;
      }
    | undefined;
  return Object.values(cities?.cohorts ?? {}).find((x) => x.linkedEconomyCohortId === cohort.id);
}
function workerCount(draft: Record<string, unknown>, cohort: LocalEconomyCohort): number {
  return liveCohort(draft, cohort)?.population ?? cohort.workersAvailable;
}
function eligibleForProducer(
  draft: Record<string, unknown>,
  cohort: LocalEconomyCohort,
  producer: LocalEconomyProducer,
): boolean {
  const live = liveCohort(draft, cohort) as { skills?: Record<string, number> } | undefined;
  return Object.entries(producer.requiredSkills ?? {}).every(
    ([skill, level]) => (live?.skills?.[skill] ?? 0) >= level,
  );
}
function cohortCity(draft: Record<string, unknown>, cohort: LocalEconomyCohort): string {
  return liveCohort(draft, cohort)?.cityId ?? cohort.cityId;
}
function cohortNeeds(
  draft: Record<string, unknown>,
  cohort: LocalEconomyCohort,
): Record<string, number> {
  return liveCohort(draft, cohort)?.dynamicNeeds ?? cohort.desiredNeeds;
}
function stock(state: AccountingState, owner: string, commodity: string) {
  return (
    state.stock.find(
      (x) => x.ownerId === owner && x.commodity === commodity && x.location === 'available',
    )?.quantity ?? 0
  );
}
export function registerLocalEconomy(engine: Engine, config: LocalEconomyConfig): void {
  const producers = structuredClone(config.producers),
    cohorts = structuredClone(config.cohorts),
    sellers = structuredClone(config.sellers);
  const configDigest = hash(config);
  const ids = (values: string[], name: string) => {
    if (
      values.some((v) => typeof v !== 'string' || !v.trim()) ||
      new Set(values).size !== values.length
    )
      throw new TypeError(`invalid or duplicate ${name}`);
  };
  ids(
    producers.map((x) => x.id),
    'producer ID',
  );
  ids(
    cohorts.map((x) => x.id),
    'cohort ID',
  );
  const marketKeys = sellers.map((s) => key(s.cityId, s.commodity));
  ids(marketKeys, 'seller market');
  if (
    producers.some(
      (p) =>
        !p.cityId?.trim() ||
        !p.ownerId?.trim() ||
        !p.accountId?.trim() ||
        !p.recipeId?.trim() ||
        !Number.isSafeInteger(p.laborPerBatch) ||
        p.laborPerBatch <= 0 ||
        !Number.isSafeInteger(p.wagePerBatch) ||
        p.wagePerBatch < 0 ||
        !Number.isSafeInteger(p.maxBatches) ||
        p.maxBatches < 0 ||
        p.maxBatches > MAX_BATCHES ||
        Object.entries(p.requiredSkills ?? {}).some(
          ([skill, level]) => !skill.trim() || !Number.isSafeInteger(level) || level < 0,
        ),
    )
  )
    throw new RangeError(`producer values invalid; maxBatches is limited to ${MAX_BATCHES}`);
  cohorts.forEach((c) => {
    if (!c.cityId?.trim() || !c.ownerId?.trim() || !c.accountId?.trim())
      throw new TypeError('invalid cohort city/owner/account');
    count(c.workersAvailable, 'workersAvailable');
    Object.values(c.desiredNeeds).forEach((n) => count(n, 'desired need'));
  });
  sellers.forEach((s) => {
    if (!s.cityId?.trim() || !s.commodity?.trim() || !s.ownerId?.trim() || !s.accountId?.trim())
      throw new TypeError('invalid seller city/commodity/owner/account');
    if (
      ![s.minPrice, s.maxPrice, s.openingPrice].every(Number.isSafeInteger) ||
      s.minPrice <= 0 ||
      s.maxPrice < s.minPrice ||
      s.openingPrice < s.minPrice ||
      s.openingPrice > s.maxPrice
    )
      throw new RangeError('invalid price bounds');
  });
  let domain = engine.getState().domain;
  if (domain.accounting === undefined)
    domain = { ...domain, accounting: createAccountingState(config) };
  const accounting = domain.accounting as AccountingState;
  assertAccountingInvariant(accounting);
  const owners = new Set(accounting.owners),
    commodities = new Set(accounting.commodities.map((c) => c.id));
  producers.forEach((p) => {
    if (
      !owners.has(p.ownerId) ||
      accounting.accounts.find((a) => a.id === p.accountId)?.ownerId !== p.ownerId ||
      !accounting.recipes.some((r) => r.id === p.recipeId)
    )
      throw new RangeError(`invalid producer references: ${p.id}`);
  });
  cohorts.forEach((c) => {
    if (
      !owners.has(c.ownerId) ||
      accounting.accounts.find((a) => a.id === c.accountId)?.ownerId !== c.ownerId ||
      Object.keys(c.desiredNeeds).some((x) => !commodities.has(x))
    )
      throw new RangeError(`invalid cohort references: ${c.id}`);
  });
  sellers.forEach((s) => {
    if (
      !owners.has(s.ownerId) ||
      accounting.accounts.find((a) => a.id === s.accountId)?.ownerId !== s.ownerId ||
      !commodities.has(s.commodity)
    )
      throw new RangeError(`invalid seller references: ${s.cityId}/${s.commodity}`);
  });
  cohorts.forEach((c) =>
    sellers.forEach((s) => {
      if (
        c.cityId === s.cityId &&
        c.desiredNeeds[s.commodity] !== undefined &&
        c.ownerId === s.ownerId &&
        c.accountId === s.accountId
      )
        throw new RangeError(
          `buyer/seller self-payment uses the same account for ${c.id}/${s.commodity}`,
        );
    }),
  );
  producers.forEach((p) => {
    if (p.wagePerBatch > 0 && !cohorts.some((c) => c.cityId === p.cityId))
      throw new RangeError(`wage-paying producer ${p.id} has no worker cohort`);
    if (
      p.wagePerBatch > 0 &&
      cohorts.some((c) => c.cityId === p.cityId && c.accountId === p.accountId)
    )
      throw new RangeError(`wage self-payment uses the same account for ${p.id}`);
  });
  const initial: EconomyState = {
    version: 1,
    configDigest,
    configCohorts: Object.fromEntries(
      cohorts.map((c) => [c.id, { cityId: c.cityId, ownerId: c.ownerId, accountId: c.accountId }]),
    ),
    producers: Object.fromEntries(
      producers.map((p) => [
        p.id,
        {
          id: p.id,
          stopped: null,
          batches: 0,
          employed: 0,
          cityId: p.cityId,
          ownerId: p.ownerId,
          accountId: p.accountId,
          recipeId: p.recipeId,
          wagePerBatch: p.wagePerBatch,
          maxBatches: p.maxBatches,
          laborPerBatch: p.laborPerBatch,
          requiredSkills: { ...(p.requiredSkills ?? {}) },
        },
      ]),
    ),
    cohorts: Object.fromEntries(
      cohorts.map((c) => [
        c.id,
        {
          unmet: Object.fromEntries(Object.keys(c.desiredNeeds).map((x) => [x, 0])),
          cumulativeUnmet: Object.fromEntries(Object.keys(c.desiredNeeds).map((x) => [x, 0])),
          reasons: Object.fromEntries(Object.keys(c.desiredNeeds).map((x) => [x, 'uninitialized'])),
        },
      ]),
    ),
    sellers: Object.fromEntries(
      sellers.map((s) => [
        key(s.cityId, s.commodity),
        { ...s, price: s.openingPrice, reason: 'opening' },
      ]),
    ),
    quotes: {},
  };
  if ((domain as Record<string, unknown>).economy !== undefined)
    throw new Error('economy state already initialized');
  // Engine snapshots are immutable views; initialize through a phase system on first tick, preserving registration state in trusted initialState.
  engine.registerPhaseSystem('infrastructure', 'local-economy:initialize', (draft) => {
    if (!draft.accounting) draft.accounting = createAccountingState(config);
    if (!draft.economy) draft.economy = structuredClone(initial);
  });
  engine.registerInvariant((d) => {
    if (d.economy !== undefined) validateEconomy(d.economy as EconomyState, configDigest);
    if (d.accounting !== undefined) assertAccountingInvariant(d.accounting as AccountingState);
  });
  engine.registerPhaseSystem('production', 'local-economy:production', (draft) => {
    const e = draft.economy as EconomyState;
    let a = draft.accounting as AccountingState;
    const employedByCohort = new Map<string, number>();
    const wageIncomeByCohort = new Map<string, number>();
    for (const result of Object.values(e.producers)) {
      const p: LocalEconomyProducer = result;
      result.batches = 0;
      result.employed = 0;
      const firm = (
        draft.firms as { firms?: Record<string, { status: string; capacity: number }> } | undefined
      )?.firms?.[p.id];
      if (firm?.status === 'closed' || firm?.status === 'insolvent') {
        result.stopped = 'closed';
        continue;
      }
      const impact = getPoliticsImpactPlan(draft, p.id);
      const capacity = checkedNumber(
        (BigInt(firm?.capacity ?? p.maxBatches) * BigInt(impact?.capacityBps ?? 10000)) / 10000n,
        'political capacity',
      );
      const wagePerBatch = checkedNumber(
        (BigInt(p.wagePerBatch) * BigInt(10000 + (impact?.wageIncreaseBps ?? 0)) + 9999n) / 10000n,
        'political wage',
      );
      const recipe = a.recipes.find((r) => r.id === p.recipeId)!;
      const eligible = cohorts.filter(
        (c) => cohortCity(draft, c) === p.cityId && eligibleForProducer(draft, c, p),
      );
      const labor = checkedNumber(
        eligible.reduce((sum, c) => sum + BigInt(workerCount(draft, c)), 0n),
        'worker count',
      );
      const workers = checkedNumber(
        BigInt(eligible.reduce((sum, c) => sum + (employedByCohort.get(c.id) ?? 0), 0)),
        'employed worker count',
      );
      const availableWorkers = Math.max(0, labor - workers);
      const liquidity = account(a, p.accountId).balance;
      let batches = Math.min(
        capacity,
        Math.floor(availableWorkers / p.laborPerBatch),
        wagePerBatch ? Math.floor(liquidity / wagePerBatch) : capacity,
        ...recipe.inputs.map((line) =>
          Math.floor(stock(a, p.ownerId, line.commodity) / line.quantity),
        ),
      );
      for (const line of recipe.outputs)
        batches = Math.min(
          batches,
          Math.floor(
            (Number.MAX_SAFE_INTEGER - stock(a, p.ownerId, line.commodity)) / line.quantity,
          ),
        );
      if (!Number.isSafeInteger(batches) || batches < 0)
        throw new RangeError('production overflow');
      result.stopped =
        batches === 0
          ? availableWorkers === 0
            ? 'no-workers'
            : recipe.inputs.some((line) => stock(a, p.ownerId, line.commodity) < line.quantity)
              ? 'missing-inputs'
              : liquidity < wagePerBatch
                ? 'no-liquidity'
                : 'capacity-or-headroom'
          : null;
      for (let i = 0; i < batches; i++) {
        const ops: AccountingOperation[] = [
          {
            type: 'conversion',
            ownerId: p.ownerId,
            recipeId: p.recipeId,
            inputs: recipe.inputs,
            outputs: recipe.outputs,
            causeId: `production:${p.id}:${i}`,
          },
        ];
        let remainingWorkers = p.laborPerBatch;
        const allocations = eligible
          .map((c) => {
            const allocated = Math.min(
              remainingWorkers,
              workerCount(draft, c) - (employedByCohort.get(c.id) ?? 0),
            );
            remainingWorkers -= allocated;
            if (allocated > 0)
              employedByCohort.set(c.id, (employedByCohort.get(c.id) ?? 0) + allocated);
            return { cohort: c, workers: allocated };
          })
          .filter((allocation) => allocation.workers > 0);
        if (wagePerBatch)
          allocations.forEach((allocation) => {
            const share = Number(
              (BigInt(wagePerBatch) * BigInt(allocation.workers)) / BigInt(p.laborPerBatch),
            );
            if (share > 0) {
              ops.push({
                type: 'payment',
                fromAccountId: p.accountId,
                toAccountId: allocation.cohort.accountId,
                amount: money(a, share),
                causeId: `wage:${p.id}:${i}:${allocation.cohort.id}`,
              });
              wageIncomeByCohort.set(
                allocation.cohort.id,
                checkedNumber(
                  BigInt(wageIncomeByCohort.get(allocation.cohort.id) ?? 0) + BigInt(share),
                  'cohort wages',
                ),
              );
            }
          });
        a = applyAccountingTransaction(
          a,
          ops,
          `production:${engine.getState().tick + 1}:${p.id}:${i}`,
        );
        result.batches++;
        result.employed += p.laborPerBatch;
      }
    }
    const cityState = draft.cities as
      | {
          cohorts?: Record<
            string,
            {
              linkedEconomyCohortId: string;
              population: number;
              employment: number;
              unemployment: number;
              incomeThisTick: number;
            }
          >;
        }
      | undefined;
    for (const cityCohort of Object.values(cityState?.cohorts ?? {})) {
      cityCohort.employment = Math.min(
        cityCohort.population,
        employedByCohort.get(cityCohort.linkedEconomyCohortId) ?? 0,
      );
      cityCohort.unemployment = cityCohort.population - cityCohort.employment;
      cityCohort.incomeThisTick = wageIncomeByCohort.get(cityCohort.linkedEconomyCohortId) ?? 0;
    }
    draft.accounting = a;
  });
  engine.registerPhaseSystem('market', 'local-economy:quote', (draft) => {
    const e = draft.economy as EconomyState,
      a = draft.accounting as AccountingState;
    for (const configured of sellers) {
      const k = key(configured.cityId, configured.commodity),
        s = e.sellers[k]!,
        supply = stock(a, s.ownerId, s.commodity),
        demand = cohorts
          .filter((c) => cohortCity(draft, c) === s.cityId)
          .reduce((sum, c) => sum + BigInt(cohortNeeds(draft, c)[s.commodity] ?? 0), 0n);
      const old = e.sellers[k]!.price;
      let price = old,
        reason = 'balanced';
      if (!supply) {
        reason = 'empty-supply';
      } else {
        const supplyValue = BigInt(supply);
        const next = BigInt(old) + (BigInt(old) * (demand - supplyValue)) / (supplyValue * 10n);
        price = Number(
          next < BigInt(s.minPrice)
            ? BigInt(s.minPrice)
            : next > BigInt(s.maxPrice)
              ? BigInt(s.maxPrice)
              : next,
        );
        if (demand > supplyValue) reason = 'excess-demand';
        else if (demand < supplyValue) reason = 'excess-supply';
      }
      e.sellers[k]!.price = price;
      e.sellers[k]!.reason = reason;
      e.quotes[k] = { price, reason };
    }
  });
  engine.registerPhaseSystem('settlement', 'local-economy:settlement', (draft) => {
    let a = draft.accounting as AccountingState;
    const e = draft.economy as EconomyState;
    for (const c of cohorts)
      for (const [commodity, desired] of Object.entries(cohortNeeds(draft, c))) {
        const state = e.cohorts[c.id]!;
        const seller = e.sellers[key(cohortCity(draft, c), commodity)];
        if (!seller) {
          state.unmet[commodity] = desired;
          state.cumulativeUnmet[commodity] = checkedNumber(
            BigInt(state.cumulativeUnmet[commodity]!) + BigInt(desired),
            'cumulative unmet need',
          );
          state.reasons[commodity] = 'no-seller';
          continue;
        }
        const price = e.quotes[key(cohortCity(draft, c), commodity)]!.price;
        const government = draft.government as
          | {
              kingdoms: Array<{ kingdomId: string; treasuryAccountId: string }>;
              policies: Array<{
                variant?: string;
                policyId: string;
                governmentId: string;
                recipientAccountId: string;
                recipientOwnerId: string;
                commodity?: string;
                amount: number;
                spent?: number;
                effectiveTick: number;
                expiryTick: number;
              }>;
              decisions: Array<Record<string, unknown>>;
              taxPolicies?: Array<{
                variant: string;
                policyId: string;
                governmentId: string;
                rateBps: number;
                incidence: 'buyer' | 'seller';
                effectiveTick: number;
                expiryTick: number;
              }>;
              cityKingdomIds?: Record<string, string>;
            }
          | undefined;
        const available = stock(a, seller.ownerId, commodity),
          budget = account(a, c.accountId).balance;
        const tick = engine.getState().tick + 1;
        const jurisdiction = government?.cityKingdomIds?.[cohortCity(draft, c)];
        const tax = government?.taxPolicies?.find(
          (policy) =>
            policy.variant === 'local-purchase-tax' &&
            policy.governmentId === jurisdiction &&
            tick >= policy.effectiveTick &&
            tick <= policy.expiryTick,
        );
        const buyerFactor = tax?.incidence === 'buyer' ? 10000 + tax.rateBps : 10000;
        const bought = Math.min(
          desired,
          available,
          Number((BigInt(budget) * 10000n) / (BigInt(price) * BigInt(buyerFactor))),
        );
        if (bought > 0) {
          const purchaseValue = checkedNumber(BigInt(bought) * BigInt(price), 'purchase amount');
          const taxAmount = tax
            ? checkedNumber(
                (BigInt(purchaseValue) * BigInt(tax.rateBps)) / 10000n,
                'local purchase tax',
              )
            : 0;
          const subsidy = government?.policies.find(
            (policy) =>
              policy.variant === 'food-subsidy' &&
              policy.governmentId === jurisdiction &&
              policy.recipientAccountId === c.accountId &&
              policy.commodity === commodity &&
              tick >= policy.effectiveTick &&
              tick <= policy.expiryTick,
          );
          const treasury = subsidy
            ? a.accounts.find(
                (item) =>
                  item.id ===
                  government!.kingdoms.find((kingdom) => kingdom.kingdomId === subsidy.governmentId)
                    ?.treasuryAccountId,
              )
            : undefined;
          const remaining = subsidy ? Math.max(0, subsidy.amount - (subsidy.spent ?? 0)) : 0;
          const requestedSubsidy = Math.min(remaining, purchaseValue);
          const subsidyAmount =
            subsidy && treasury ? Math.min(requestedSubsidy, treasury.balance) : 0;
          const taxTreasury = tax
            ? a.accounts.find(
                (item) =>
                  item.id ===
                  government!.kingdoms.find((kingdom) => kingdom.kingdomId === tax.governmentId)
                    ?.treasuryAccountId,
              )
            : undefined;
          if (subsidy) {
            const selected =
              requestedSubsidy === 0 || subsidyAmount === 0
                ? 'reject'
                : subsidyAmount === requestedSubsidy
                  ? 'fund'
                  : 'reduce';
            government!.decisions.push({
              kingdomId: subsidy.governmentId,
              policyId: subsidy.policyId,
              tick,
              selected,
              cause: 'actual grain purchase settlement',
              reason:
                selected === 'fund'
                  ? `paid the requested subsidy ${subsidyAmount} against an actual ${commodity} purchase`
                  : `requested subsidy ${requestedSubsidy}; paid ${subsidyAmount} because available treasury or guarantee was insufficient`,
              alternatives: ['fund', 'reduce', 'reject'],
              information: [
                `purchase=${purchaseValue}`,
                `treasury=${treasury?.balance ?? 0}`,
                `guaranteeRemaining=${remaining}`,
              ],
              constraints: [
                'payment requires an actual commodity purchase',
                'treasury and guarantee cannot be overdrawn',
              ],
            });
          }
          const operations: AccountingOperation[] = [
            {
              type: 'payment',
              fromAccountId: c.accountId,
              toAccountId: seller.accountId,
              amount: money(a, purchaseValue),
              causeId: `purchase:${c.id}:${commodity}`,
            },
            {
              type: 'transfer',
              ownerId: seller.ownerId,
              toOwnerId: c.ownerId,
              commodity,
              quantity: quantity(a, commodity, bought),
              from: 'available',
              to: 'available',
              causeId: `purchase:${c.id}:${commodity}`,
            },
            {
              type: 'consume',
              ownerId: c.ownerId,
              commodity,
              quantity: quantity(a, commodity, bought),
              causeId: `consumption:${c.id}:${commodity}`,
            },
          ];
          if (taxAmount > 0 && tax && taxTreasury) {
            operations.push({
              type: 'payment',
              fromAccountId: tax.incidence === 'buyer' ? c.accountId : seller.accountId,
              toAccountId: taxTreasury.id,
              amount: money(a, taxAmount),
              causeId: `government:${tax.policyId}:purchase:${c.id}:${commodity}`,
            });
          }
          if (subsidyAmount > 0 && subsidy && treasury) {
            operations.push({
              type: 'payment',
              fromAccountId: treasury.id,
              toAccountId: c.accountId,
              amount: money(a, subsidyAmount),
              causeId: `government:${subsidy.policyId}:purchase:${c.id}:${commodity}`,
            });
          }
          a = applyAccountingTransaction(a, operations, `settlement:${tick}:${c.id}:${commodity}`);
          if (subsidy && subsidyAmount > 0) subsidy.spent = (subsidy.spent ?? 0) + subsidyAmount;
        }
        const unmet = desired - bought;
        state.unmet[commodity] = unmet;
        state.reasons[commodity] =
          unmet === 0
            ? 'fulfilled'
            : available === 0
              ? 'empty-supply'
              : budget < price
                ? 'no-liquidity'
                : 'insufficient-supply';
        state.cumulativeUnmet[commodity] = checkedNumber(
          BigInt(state.cumulativeUnmet[commodity]!) + BigInt(unmet),
          'cumulative unmet need',
        );
      }
    draft.accounting = a;
  });
}
function validateEconomy(e: EconomyState, expectedConfigDigest: string) {
  if (
    !e ||
    e.version !== 1 ||
    e.configDigest !== expectedConfigDigest ||
    !e.producers ||
    !e.cohorts ||
    !e.sellers ||
    !e.quotes
  )
    throw new TypeError('invalid economy state or registered config digest');
  for (const c of Object.values(e.cohorts))
    for (const n of [...Object.values(c.unmet), ...Object.values(c.cumulativeUnmet)])
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('invalid unmet need');
  for (const s of Object.values(e.sellers))
    if (!Number.isSafeInteger(s.price) || s.price <= 0)
      throw new RangeError('invalid market price');
}
