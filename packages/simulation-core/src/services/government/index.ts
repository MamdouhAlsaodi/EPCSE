import {
  applyAccountingTransaction,
  type AccountingAccount,
  type AccountingState,
} from '../accounting/index.js';
import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { hash } from '../../shared/canonical.js';

export interface GovernmentRecipient {
  readonly kingdomId: string;
  readonly ownerId: string;
  readonly accountId: string;
}
export interface GovernmentKingdom {
  readonly kingdomId: string;
  readonly controller: 'player' | 'ai';
  readonly treasuryAccountId: string;
  readonly recipients: readonly GovernmentRecipient[];
  readonly aiPolicy?: {
    readonly recipientOwnerId: string;
    readonly recipientAccountId: string;
    readonly amount: number;
    readonly reserve: number;
  };
}
export interface GovernmentConfig {
  readonly kingdoms: readonly GovernmentKingdom[];
  /** Omitted jurisdictions retain legacy immediate-approval behavior. */
  readonly institutions?: Readonly<Record<string, GovernmentInstitution>>;
  /** Trusted jurisdiction mapping used by local-economy policy settlement. */
  readonly cityKingdomIds?: Readonly<Record<string, string>>;
}
export type GovernmentInstitution =
  'city-council' | 'monarchy' | 'parliamentary' | 'central-republic';

export interface InstitutionalDecisionInput {
  readonly institution: GovernmentInstitution;
  readonly legitimacy: number;
  readonly quorum: number;
  readonly support: number;
  readonly oppositionVeto: boolean;
}

export interface InstitutionalDecision {
  readonly approved: boolean;
  readonly effectiveDelay: number;
  readonly selected: string;
  readonly alternatives: string[];
  readonly reason: string;
  readonly constraints: string[];
}

export interface FundedTransferPolicy {
  readonly policyId: string;
  readonly governmentId: string;
  readonly recipientKingdomId: string;
  readonly recipientOwnerId: string;
  readonly recipientAccountId: string;
  readonly amount: number;
  readonly effectiveTick: number;
  readonly expiryTick: number;
  readonly variant?: 'transfer' | 'food-subsidy' | 'import-tariff' | 'trade-restriction';
  readonly importKingdomId?: string;
  readonly routeId?: string;
  readonly commodity?: string;
  readonly spent?: number;
}
type GovernmentState = {
  version: 2;
  configDigest: string;
  kingdoms: GovernmentKingdom[];
  cityKingdomIds: Record<string, string>;
  policies: FundedTransferPolicy[];
  applied: string[];
  authorityDecisions: Array<{
    kingdomId: string;
    policyId: string;
    tick: number;
    decision: InstitutionalDecision;
  }>;
  tradePolicies: TradePolicy[];
  taxPolicies: LocalPurchaseTaxPolicy[];
  investments: CapitalInvestment[];
  decisions: Array<{
    kingdomId: string;
    policyId: string;
    tick: number;
    selected: string;
    cause: string;
    reason: string;
    alternatives: string[];
    information: string[];
    constraints: string[];
  }>;
};
export interface LocalPurchaseTaxPolicy {
  readonly variant: 'local-purchase-tax';
  readonly policyId: string;
  readonly governmentId: string;
  readonly rateBps: number;
  readonly incidence: 'buyer' | 'seller';
  readonly effectiveTick: number;
  readonly expiryTick: number;
}
export interface CapitalInvestment {
  readonly policyId: string;
  readonly governmentId: string;
  readonly cityId: string;
  readonly service?: string;
  readonly routeId?: string;
  readonly contractorAccountId: string;
  readonly cost: number;
  readonly capacityIncrease: number;
  readonly effectiveTick: number;
  readonly expiryTick: number;
  applied: boolean;
  expired: boolean;
}
export interface TradePolicy {
  readonly variant: 'import-tariff' | 'trade-restriction';
  readonly policyId: string;
  readonly governmentId: string;
  readonly importKingdomId: string;
  readonly routeId: string;
  readonly commodity: string;
  readonly amount: number;
  readonly effectiveTick: number;
  readonly expiryTick: number;
}
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const validPolicy = (p: FundedTransferPolicy) =>
  !!p &&
  text(p.policyId) &&
  text(p.governmentId) &&
  text(p.recipientKingdomId) &&
  text(p.recipientOwnerId) &&
  text(p.recipientAccountId) &&
  Number.isSafeInteger(p.amount) &&
  p.amount > 0 &&
  Number.isSafeInteger(p.effectiveTick) &&
  p.effectiveTick > 0 &&
  Number.isSafeInteger(p.expiryTick) &&
  p.expiryTick >= p.effectiveTick;
const validKingdom = (k: GovernmentKingdom) =>
  !!k &&
  text(k.kingdomId) &&
  ['player', 'ai'].includes(k.controller) &&
  text(k.treasuryAccountId) &&
  Array.isArray(k.recipients) &&
  k.recipients.length > 0 &&
  k.recipients.every(
    (r) =>
      !!r &&
      r.kingdomId === k.kingdomId &&
      text(r.ownerId) &&
      r.ownerId === k.kingdomId &&
      text(r.accountId),
  ) &&
  (!k.aiPolicy ||
    (text(k.aiPolicy.recipientOwnerId) &&
      text(k.aiPolicy.recipientAccountId) &&
      k.aiPolicy.recipientAccountId !== k.treasuryAccountId &&
      Number.isSafeInteger(k.aiPolicy.amount) &&
      k.aiPolicy.amount > 0 &&
      Number.isSafeInteger(k.aiPolicy.reserve) &&
      k.aiPolicy.reserve >= 0));
export function decideInstitutionalPolicy(
  input: InstitutionalDecisionInput,
): InstitutionalDecision {
  const values = [input?.legitimacy, input?.quorum, input?.support];
  if (
    !input ||
    !['city-council', 'monarchy', 'parliamentary', 'central-republic'].includes(
      input.institution,
    ) ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100) ||
    typeof input.oppositionVeto !== 'boolean'
  )
    throw new TypeError('invalid institutional decision input');

  const rules: Record<
    GovernmentInstitution,
    { legitimacy: number; support: number; quorum: number; veto: boolean; delay: number }
  > = {
    'city-council': { legitimacy: 50, support: 40, quorum: 60, veto: true, delay: 2 },
    monarchy: { legitimacy: 40, support: 30, quorum: 0, veto: false, delay: 1 },
    parliamentary: { legitimacy: 50, support: 50, quorum: 60, veto: true, delay: 3 },
    'central-republic': { legitimacy: 60, support: 50, quorum: 0, veto: true, delay: 1 },
  };
  const rule = rules[input.institution];
  const approved =
    input.legitimacy >= rule.legitimacy &&
    input.support >= rule.support &&
    input.quorum >= rule.quorum &&
    (!rule.veto || !input.oppositionVeto);
  const constraints = [
    `legitimacy>=${rule.legitimacy}`,
    `support>=${rule.support}`,
    `quorum>=${rule.quorum}`,
    `veto-blocks=${rule.veto}`,
  ];
  return {
    approved,
    effectiveDelay: approved ? rule.delay : 0,
    selected: approved ? 'approve' : 'retain-status-quo',
    alternatives: ['approve', 'retain-status-quo'],
    constraints,
    reason: approved
      ? `${input.institution} authority rule satisfied`
      : `${input.institution} authority threshold or veto not satisfied`,
  };
}

export function assessGovernmentTax(
  state: AccountingState,
  input: {
    policyId: string;
    payerAccountId: string;
    treasuryAccountId: string;
    amount: number;
    taxableEventId: string;
    tick: number;
  },
): AccountingState {
  if (
    !input ||
    !text(input.policyId) ||
    !text(input.payerAccountId) ||
    !text(input.treasuryAccountId) ||
    !text(input.taxableEventId) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    !Number.isSafeInteger(input.tick) ||
    input.tick < 1
  )
    throw new TypeError('invalid government tax assessment');
  const transactionId = `government:tax:${input.policyId}:${input.taxableEventId}`;
  if (state.journal.some((entry) => entry.transactionId === transactionId)) return state;
  const payer = state.accounts.find((account) => account.id === input.payerAccountId);
  const treasury = state.accounts.find((account) => account.id === input.treasuryAccountId);
  if (!payer || !treasury || payer.id === treasury.id || payer.ownerId !== treasury.ownerId)
    throw new TypeError('taxpayer and treasury must be distinct accounts in one jurisdiction');
  return applyAccountingTransaction(
    state,
    [
      {
        type: 'payment',
        fromAccountId: payer.id,
        toAccountId: treasury.id,
        amount: {
          kind: 'money',
          currencyId: state.currency.id,
          unit: state.currency.unit,
          scale: state.currency.scale,
          minor: input.amount,
        },
        causeId: `government:${input.policyId}:event:${input.taxableEventId}`,
      },
    ],
    transactionId,
  );
}

function allowed(
  kingdom: GovernmentKingdom,
  recipientKingdomId: string,
  ownerId: string,
  accountId: string,
) {
  return (
    recipientKingdomId === kingdom.kingdomId &&
    kingdom.recipients.some(
      (r) =>
        r.kingdomId === recipientKingdomId && r.ownerId === ownerId && r.accountId === accountId,
    )
  );
}
export function scheduleFundedTransfer(
  policy: FundedTransferPolicy,
  kingdoms: readonly GovernmentKingdom[],
  accounts: readonly Pick<AccountingAccount, 'id' | 'ownerId'>[],
): FundedTransferPolicy {
  const k = kingdoms.find((item) => item.kingdomId === policy?.governmentId);
  if (
    !validPolicy(policy) ||
    !k ||
    policy.recipientAccountId === k.treasuryAccountId ||
    !allowed(k, policy.recipientKingdomId, policy.recipientOwnerId, policy.recipientAccountId) ||
    policy.recipientKingdomId !== policy.governmentId ||
    accounts.find((a) => a.id === policy.recipientAccountId)?.ownerId !== policy.recipientOwnerId ||
    accounts.find((a) => a.id === k.treasuryAccountId)?.ownerId !== k.kingdomId
  )
    throw new TypeError('invalid or unauthorized funded transfer');
  return structuredClone(policy);
}
export function applyScheduledTransfer(
  state: AccountingState,
  policy: FundedTransferPolicy,
  tick: number,
  treasuryAccountId: string,
): AccountingState {
  if (!validPolicy(policy) || !text(treasuryAccountId) || !Number.isSafeInteger(tick) || tick < 0)
    throw new TypeError('invalid policy tick');
  if (tick < policy.effectiveTick || tick > policy.expiryTick) return state;
  const treasury = state.accounts.find(
    (a) => a.id === treasuryAccountId && a.ownerId === policy.governmentId,
  );
  const recipient = state.accounts.find(
    (a) => a.id === policy.recipientAccountId && a.ownerId === policy.recipientOwnerId,
  );
  if (!treasury || !recipient || treasury.balance < policy.amount) return state;
  return applyAccountingTransaction(
    state,
    [
      {
        type: 'payment',
        fromAccountId: treasury.id,
        toAccountId: recipient.id,
        amount: {
          kind: 'money',
          currencyId: state.currency.id,
          unit: state.currency.unit,
          scale: state.currency.scale,
          minor: policy.amount,
        },
        causeId: `government:${policy.policyId}`,
      },
    ],
    `government:${policy.policyId}:${tick}`,
  );
}
function hasPolicyId(g: GovernmentState, policyId: string): boolean {
  return (
    g.policies.some((policy) => policy.policyId === policyId) ||
    g.taxPolicies.some((policy) => policy.policyId === policyId) ||
    g.tradePolicies.some((policy) => policy.policyId === policyId) ||
    g.investments.some((policy) => policy.policyId === policyId)
  );
}

function canReserveFoodGuarantee(
  policies: readonly FundedTransferPolicy[],
  candidate: FundedTransferPolicy,
  available: number,
): boolean {
  const ticks = [
    candidate.effectiveTick,
    ...policies
      .filter(
        (policy) =>
          policy.variant === 'food-subsidy' &&
          policy.governmentId === candidate.governmentId &&
          policy.effectiveTick >= candidate.effectiveTick &&
          policy.effectiveTick <= candidate.expiryTick,
      )
      .map((policy) => policy.effectiveTick),
  ];
  return ticks.every((tick) => {
    if (tick > candidate.expiryTick) return true;
    const committed = policies
      .filter(
        (policy) =>
          policy.variant === 'food-subsidy' &&
          policy.governmentId === candidate.governmentId &&
          tick >= policy.effectiveTick &&
          tick <= policy.expiryTick,
      )
      .reduce((sum, policy) => sum + BigInt(Math.max(0, policy.amount - (policy.spent ?? 0))), 0n);
    return committed + BigInt(candidate.amount) <= BigInt(available);
  });
}

function canScheduleInvestment(
  investments: readonly CapitalInvestment[],
  candidate: Pick<
    CapitalInvestment,
    'cityId' | 'service' | 'capacityIncrease' | 'effectiveTick' | 'expiryTick'
  >,
  currentCapacity: number,
): boolean {
  const overlapping = investments.filter(
    (investment) =>
      investment.cityId === candidate.cityId && investment.service === candidate.service,
  );
  const ticks = new Set([candidate.effectiveTick]);
  for (const investment of overlapping) {
    if (
      investment.effectiveTick >= candidate.effectiveTick &&
      investment.effectiveTick <= candidate.expiryTick
    )
      ticks.add(investment.effectiveTick);
    if (
      investment.expiryTick + 1 >= candidate.effectiveTick &&
      investment.expiryTick + 1 <= candidate.expiryTick
    )
      ticks.add(investment.expiryTick + 1);
  }
  return [...ticks].every((tick) => {
    const projected = overlapping.reduce((capacity, investment) => {
      if (investment.applied && !investment.expired)
        return capacity - (investment.expiryTick < tick ? investment.capacityIncrease : 0);
      return (
        capacity +
        (tick >= investment.effectiveTick && tick <= investment.expiryTick
          ? investment.capacityIncrease
          : 0)
      );
    }, currentCapacity);
    return projected <= 1000 - candidate.capacityIncrease;
  });
}

function reservedFoodGuarantee(
  policies: readonly FundedTransferPolicy[],
  governmentId: string,
  tick: number,
): number {
  const reserved = policies
    .filter(
      (policy) =>
        policy.variant === 'food-subsidy' &&
        policy.governmentId === governmentId &&
        tick >= policy.effectiveTick &&
        tick <= policy.expiryTick,
    )
    .reduce((sum, policy) => sum + BigInt(Math.max(0, policy.amount - (policy.spent ?? 0))), 0n);
  return Number(
    reserved > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : reserved,
  );
}

export function registerGovernment(engine: Engine, config: GovernmentConfig): void {
  if (
    !config ||
    !Array.isArray(config.kingdoms) ||
    config.kingdoms.length < 2 ||
    config.kingdoms.some((k) => !validKingdom(k)) ||
    config.kingdoms.filter((k) => k.controller === 'player').length !== 1 ||
    new Set(config.kingdoms.map((k) => k.kingdomId)).size !== config.kingdoms.length
  )
    throw new TypeError('invalid government configuration');
  if (
    config.institutions &&
    Object.entries(config.institutions).some(
      ([kingdomId, institution]) =>
        !config.kingdoms.some((kingdom) => kingdom.kingdomId === kingdomId) ||
        !['city-council', 'monarchy', 'parliamentary', 'central-republic'].includes(institution),
    )
  )
    throw new TypeError('invalid government institution mapping');
  if (
    config.cityKingdomIds &&
    Object.entries(config.cityKingdomIds).some(
      ([cityId, kingdomId]) =>
        !text(cityId) || !config.kingdoms.some((kingdom) => kingdom.kingdomId === kingdomId),
    )
  )
    throw new TypeError('invalid government city jurisdiction mapping');
  const kingdoms = structuredClone(config.kingdoms),
    institutions = structuredClone(config.institutions ?? {}),
    cityKingdomIds = structuredClone(config.cityKingdomIds ?? {}),
    digest = hash({ kingdoms, institutions, cityKingdomIds }),
    initial: GovernmentState = {
      version: 2,
      configDigest: digest,
      kingdoms,
      cityKingdomIds,
      policies: [],
      tradePolicies: [],
      taxPolicies: [],
      investments: [],
      applied: [],
      authorityDecisions: [],
      decisions: [],
    };
  const initialize = (d: Record<string, unknown>) => {
    if (!d.government) d.government = structuredClone(initial);
  };
  engine.registerPhaseSystem('infrastructure', 'government:initialize', initialize);
  engine.registerInvariant((d) => {
    const g = d.government as GovernmentState | undefined;
    if (
      g &&
      (g.version !== 2 ||
        g.configDigest !== digest ||
        hash({ kingdoms: g.kingdoms, institutions, cityKingdomIds: g.cityKingdomIds }) !== digest ||
        !Array.isArray(g.policies) ||
        !Array.isArray(g.tradePolicies) ||
        !Array.isArray(g.taxPolicies) ||
        !Array.isArray(g.investments) ||
        !Array.isArray(g.applied) ||
        !Array.isArray(g.authorityDecisions) ||
        !Array.isArray(g.decisions))
    )
      throw new TypeError('invalid government state');
    const diplomacy = d.diplomacy as
      { kingdoms?: Array<{ kingdomId: string; controller: 'player' | 'ai' }> } | undefined;
    if (
      g &&
      diplomacy &&
      (!Array.isArray(diplomacy.kingdoms) ||
        diplomacy.kingdoms.length !== g.kingdoms.length ||
        g.kingdoms.some(
          (kingdom) =>
            diplomacy.kingdoms!.find((item) => item.kingdomId === kingdom.kingdomId)?.controller !==
            kingdom.controller,
        ))
    )
      throw new TypeError('government and diplomacy kingdom roles do not match');
    const accounting = d.accounting as AccountingState | undefined;
    if (
      g &&
      accounting &&
      g.kingdoms.some(
        (k) =>
          accounting.accounts.find((a) => a.id === k.treasuryAccountId)?.ownerId !== k.kingdomId ||
          k.recipients.some(
            (r) => accounting.accounts.find((a) => a.id === r.accountId)?.ownerId !== r.ownerId,
          ),
      )
    )
      throw new TypeError('government account mapping does not match accounting');
  });
  engine.registerCommandHandler('government.policy', (d, payload) => {
    try {
      initialize(d);
      const p = payload as Omit<FundedTransferPolicy, 'variant'> & {
        variant?: string;
        kingdomId?: unknown;
        expiryTick?: number;
        rateBps?: number;
        incidence?: string;
        legitimacy?: number;
        quorum?: number;
        support?: number;
        oppositionVeto?: boolean;
      };
      const k = kingdoms.find((x) => x.kingdomId === p?.governmentId);
      if (!p || p.kingdomId !== p.governmentId || !k || k.controller !== 'player')
        throw new TypeError('government command restricted to player kingdom');
      const state = d.accounting as AccountingState | undefined;
      if (!state) throw new TypeError('government accounting unavailable');
      const variant = p.variant ?? 'transfer';
      if (variant === 'capital-investment') {
        const investment = p as typeof p & {
          targetRouteId?: string;
          carrierAccountId?: string;
          policyId: string;
          targetCityId: string;
          service: string;
          contractorAccountId: string;
          cost: number;
          capacityIncrease: number;
          effectiveTick: number;
          expiryTick: number;
        };
        const now = engine.getState().tick + 1;
        const g = d.government as GovernmentState;
        if (investment.targetRouteId !== undefined) {
          const logistics = d.logistics as
            | {
                routes?: Array<{
                  routeId: string;
                  sourceCityId: string;
                  capacity: number;
                  carrierAccountId: string;
                }>;
              }
            | undefined;
          const route = logistics?.routes?.find(
            (item) => item.routeId === investment.targetRouteId,
          );
          const contractor = state.accounts.find((item) => item.id === investment.carrierAccountId);
          const treasury = state.accounts.find((item) => item.id === k.treasuryAccountId);
          const capacityIncrease = investment.capacityIncrease;
          const effectiveTick = investment.effectiveTick;
          const expiryTick = investment.expiryTick;
          const overlap = g.investments.filter((item) => item.routeId === investment.targetRouteId);
          const ticks = new Set([
            effectiveTick,
            ...overlap.flatMap((item) => [item.effectiveTick, item.expiryTick + 1]),
          ]);
          const fits = [...ticks].every(
            (tick) =>
              tick < effectiveTick ||
              tick > expiryTick ||
              route!.capacity +
                overlap
                  .filter((item) => tick >= item.effectiveTick && tick <= item.expiryTick)
                  .reduce((sum, item) => sum + item.capacityIncrease, capacityIncrease) <=
                1000,
          );
          if (
            !text(investment.policyId) ||
            !route ||
            cityKingdomIds[route.sourceCityId] !== k.kingdomId ||
            investment.carrierAccountId !== route.carrierAccountId ||
            !contractor ||
            !Number.isSafeInteger(investment.cost) ||
            investment.cost < 1 ||
            investment.cost > 1_000_000 ||
            !Number.isSafeInteger(capacityIncrease) ||
            capacityIncrease < 1 ||
            capacityIncrease > 1000 - route.capacity ||
            !Number.isSafeInteger(effectiveTick) ||
            effectiveTick < now ||
            !Number.isSafeInteger(expiryTick) ||
            expiryTick < effectiveTick ||
            hasPolicyId(g, investment.policyId) ||
            !fits ||
            !treasury ||
            treasury.balance < investment.cost
          )
            throw new TypeError('invalid or unfunded road investment');
          const institution = institutions[k.kingdomId];
          let authority: InstitutionalDecision | undefined;
          if (institution) {
            authority = decideInstitutionalPolicy({
              institution,
              legitimacy: (p as typeof p & { legitimacy: number }).legitimacy,
              quorum: (p as typeof p & { quorum: number }).quorum,
              support: (p as typeof p & { support: number }).support,
              oppositionVeto: (p as typeof p & { oppositionVeto: boolean }).oppositionVeto,
            });
            if (!authority.approved || effectiveTick < now + authority.effectiveDelay)
              throw new TypeError('institution rejected or delayed investment');
          }
          d.accounting = applyAccountingTransaction(
            state,
            [
              {
                type: 'payment',
                fromAccountId: treasury.id,
                toAccountId: contractor.id,
                amount: {
                  kind: 'money',
                  currencyId: state.currency.id,
                  unit: state.currency.unit,
                  scale: state.currency.scale,
                  minor: investment.cost,
                },
                causeId: `government:${investment.policyId}:contract`,
              },
            ],
            `government:${investment.policyId}:contract`,
          );
          g.investments.push({
            policyId: investment.policyId,
            governmentId: k.kingdomId,
            cityId: route.sourceCityId,
            routeId: route.routeId,
            contractorAccountId: contractor.id,
            cost: investment.cost,
            capacityIncrease,
            effectiveTick,
            expiryTick,
            applied: false,
            expired: false,
          });
          if (authority)
            g.authorityDecisions.push({
              kingdomId: k.kingdomId,
              policyId: investment.policyId,
              tick: now,
              decision: authority,
            });
          g.decisions.push({
            kingdomId: k.kingdomId,
            policyId: investment.policyId,
            tick: now,
            selected: 'fund',
            cause: 'player-directed road capital investment',
            reason: `carrier contract paid ${investment.cost}; route capacity increase ${capacityIncrease} scheduled for ticks ${effectiveTick}-${expiryTick}`,
            alternatives: ['fund', 'retain-treasury'],
            information: [
              `treasury-before=${treasury.balance}`,
              `carrier=${contractor.id}`,
              `route=${route.routeId}`,
              `capacity-before=${route.capacity}`,
            ],
            constraints: [
              'trusted source-city jurisdiction',
              'configured route carrier',
              'cost<=1000000',
              'capacity<=1000',
              'treasury fully funds contract',
            ],
          });
          return;
        }
        const cities = d.cities as
          | {
              cities?: Record<
                string,
                { serviceCapacity: Record<string, number>; serviceProviderAccountId?: string }
              >;
            }
          | undefined;
        const city = cities?.cities?.[investment.targetCityId];
        const contractor = state.accounts.find(
          (account) => account.id === investment.contractorAccountId,
        );
        const treasury = state.accounts.find((account) => account.id === k.treasuryAccountId);
        const currentCapacity = city?.serviceCapacity[investment.service];
        if (
          !text(investment.policyId) ||
          !text(investment.targetCityId) ||
          !text(investment.service) ||
          !city ||
          cityKingdomIds[investment.targetCityId] !== k.kingdomId ||
          !Number.isSafeInteger(investment.cost) ||
          investment.cost < 1 ||
          investment.cost > 1_000_000 ||
          !Number.isSafeInteger(investment.capacityIncrease) ||
          investment.capacityIncrease < 1 ||
          investment.capacityIncrease > 1000 ||
          !Number.isSafeInteger(currentCapacity) ||
          currentCapacity! < 0 ||
          currentCapacity! > 1000 - investment.capacityIncrease ||
          city.serviceProviderAccountId !== investment.contractorAccountId ||
          !contractor ||
          contractor.ownerId === k.kingdomId ||
          !treasury ||
          treasury.balance < investment.cost ||
          !Number.isSafeInteger(investment.effectiveTick) ||
          investment.effectiveTick < now ||
          !Number.isSafeInteger(investment.expiryTick) ||
          investment.expiryTick < investment.effectiveTick ||
          hasPolicyId(g, investment.policyId) ||
          !canScheduleInvestment(
            g.investments,
            {
              cityId: investment.targetCityId,
              service: investment.service,
              capacityIncrease: investment.capacityIncrease,
              effectiveTick: investment.effectiveTick,
              expiryTick: investment.expiryTick,
            },
            currentCapacity!,
          )
        )
          throw new TypeError('invalid or unfunded capital investment');
        const institution = institutions[k.kingdomId];
        let authority: InstitutionalDecision | undefined;
        if (institution) {
          authority = decideInstitutionalPolicy({
            institution,
            legitimacy: (p as typeof p & { legitimacy: number }).legitimacy,
            quorum: (p as typeof p & { quorum: number }).quorum,
            support: (p as typeof p & { support: number }).support,
            oppositionVeto: (p as typeof p & { oppositionVeto: boolean }).oppositionVeto,
          });
          if (!authority.approved || investment.effectiveTick < now + authority.effectiveDelay)
            throw new TypeError('institution rejected or delayed investment');
        }
        const next = applyAccountingTransaction(
          state,
          [
            {
              type: 'payment',
              fromAccountId: treasury.id,
              toAccountId: contractor.id,
              amount: {
                kind: 'money',
                currencyId: state.currency.id,
                unit: state.currency.unit,
                scale: state.currency.scale,
                minor: investment.cost,
              },
              causeId: `government:${investment.policyId}:contract`,
            },
          ],
          `government:${investment.policyId}:contract`,
        );
        d.accounting = next;
        g.investments.push({
          policyId: investment.policyId,
          governmentId: k.kingdomId,
          cityId: investment.targetCityId,
          service: investment.service,
          contractorAccountId: contractor.id,
          cost: investment.cost,
          capacityIncrease: investment.capacityIncrease,
          effectiveTick: investment.effectiveTick,
          expiryTick: investment.expiryTick,
          applied: false,
          expired: false,
        });
        if (authority)
          g.authorityDecisions.push({
            kingdomId: k.kingdomId,
            policyId: investment.policyId,
            tick: now,
            decision: authority,
          });
        g.decisions.push({
          kingdomId: k.kingdomId,
          policyId: investment.policyId,
          tick: now,
          selected: 'fund',
          cause: 'player-directed service capital investment',
          reason: `contract paid ${investment.cost}; capacity increase ${investment.capacityIncrease} scheduled for ticks ${investment.effectiveTick}-${investment.expiryTick}`,
          alternatives: ['fund', 'retain-treasury'],
          information: [
            `treasury-before=${treasury.balance}`,
            `contractor=${contractor.id}`,
            `city=${investment.targetCityId}`,
            `capacity-before=${currentCapacity}`,
          ],
          constraints: [
            'trusted city jurisdiction',
            'configured service contractor',
            'cost<=1000000',
            'capacity<=1000',
            'treasury fully funds contract',
          ],
        });
        return;
      }
      if (variant === 'local-purchase-tax') {
        const tax = p as unknown as LocalPurchaseTaxPolicy;
        const now = engine.getState().tick + 1;
        if (
          !Number.isSafeInteger(tax.rateBps) ||
          tax.rateBps < 1 ||
          tax.rateBps > 10000 ||
          !['buyer', 'seller'].includes(tax.incidence) ||
          !Number.isSafeInteger(tax.effectiveTick) ||
          tax.effectiveTick < now ||
          !Number.isSafeInteger(tax.expiryTick) ||
          tax.expiryTick < tax.effectiveTick
        )
          throw new TypeError('invalid bounded local purchase tax');
        const g = d.government as GovernmentState;
        if (hasPolicyId(g, tax.policyId)) throw new TypeError('duplicate policy');
        if (
          g.taxPolicies.some(
            (existing) =>
              existing.governmentId === tax.governmentId &&
              tax.effectiveTick <= existing.expiryTick &&
              existing.effectiveTick <= tax.expiryTick,
          )
        )
          throw new TypeError('overlapping local purchase tax for government');
        const institution = institutions[k.kingdomId];
        if (institution) {
          const decision = decideInstitutionalPolicy({
            institution,
            legitimacy: (p as typeof p & { legitimacy: number }).legitimacy,
            quorum: (p as typeof p & { quorum: number }).quorum,
            support: (p as typeof p & { support: number }).support,
            oppositionVeto: (p as typeof p & { oppositionVeto: boolean }).oppositionVeto,
          });
          if (!decision.approved || tax.effectiveTick < now + decision.effectiveDelay)
            throw new TypeError('institution rejected or delayed policy');
          g.authorityDecisions.push({
            kingdomId: k.kingdomId,
            policyId: tax.policyId,
            tick: now,
            decision,
          });
        }
        g.taxPolicies.push(structuredClone(tax));
        return;
      }
      if (variant === 'import-tariff' || variant === 'trade-restriction') {
        const trade = p as unknown as TradePolicy;
        const importer = kingdoms.find((item) => item.kingdomId === trade.importKingdomId);
        const now = engine.getState().tick + 1;
        if (
          !text(trade.policyId) ||
          !importer ||
          trade.importKingdomId !== k.kingdomId ||
          !text(trade.routeId) ||
          !text(trade.commodity) ||
          !Number.isSafeInteger(trade.effectiveTick) ||
          trade.effectiveTick < now ||
          !Number.isSafeInteger(trade.expiryTick) ||
          trade.expiryTick < trade.effectiveTick ||
          (variant === 'import-tariff' &&
            (!Number.isSafeInteger(trade.amount) || trade.amount <= 0)) ||
          (variant === 'trade-restriction' && trade.amount !== undefined && trade.amount !== 0)
        )
          throw new TypeError('invalid scoped trade policy');
        const g = d.government as GovernmentState;
        if (hasPolicyId(g, trade.policyId)) throw new TypeError('duplicate policy');
        const institution = institutions[k.kingdomId];
        if (institution) {
          const decision = decideInstitutionalPolicy({
            institution,
            legitimacy: (p as typeof p & { legitimacy: number }).legitimacy,
            quorum: (p as typeof p & { quorum: number }).quorum,
            support: (p as typeof p & { support: number }).support,
            oppositionVeto: (p as typeof p & { oppositionVeto: boolean }).oppositionVeto,
          });
          if (!decision.approved) throw new TypeError('institution rejected policy');
          if (trade.effectiveTick < now + decision.effectiveDelay)
            throw new TypeError('effective tick precedes institutional delay');
          g.authorityDecisions.push({
            kingdomId: k.kingdomId,
            policyId: trade.policyId,
            tick: now,
            decision,
          });
        }
        g.tradePolicies.push(structuredClone({ ...trade, variant }));
        return;
      }
      if (variant !== 'transfer' && variant !== 'food-subsidy')
        throw new TypeError('unsupported government policy variant');
      const defaultExpiry = p.expiryTick === undefined;
      const expiryTick =
        p.expiryTick ?? (variant === 'food-subsidy' ? p.effectiveTick + 59 : undefined);
      if (!Number.isSafeInteger(expiryTick)) throw new TypeError('policy expiry is required');
      const candidate = {
        ...p,
        variant,
        expiryTick: expiryTick!,
        ...(variant === 'food-subsidy' ? { spent: 0 } : {}),
      } as FundedTransferPolicy;
      let policy: FundedTransferPolicy;
      if (variant === 'food-subsidy') {
        const cohorts =
          (
            d.economy as
              | {
                  configCohorts?: Record<
                    string,
                    { cityId: string; ownerId: string; accountId: string }
                  >;
                }
              | undefined
          )?.configCohorts ?? {};
        const accountOwner = state.accounts.find(
          (account) => account.id === candidate.recipientAccountId,
        )?.ownerId;
        if (
          !validPolicy(candidate) ||
          candidate.recipientKingdomId !== k.kingdomId ||
          accountOwner !== candidate.recipientOwnerId ||
          !Object.values(cohorts).some(
            (cohort) =>
              cohort.accountId === candidate.recipientAccountId &&
              cohort.ownerId === candidate.recipientOwnerId &&
              cityKingdomIds[cohort.cityId] === k.kingdomId,
          )
        )
          throw new TypeError('food subsidy recipient must be a mapped local cohort');
        policy = structuredClone(candidate);
      } else {
        policy = scheduleFundedTransfer(candidate, kingdoms, state.accounts);
      }
      const g = d.government as GovernmentState;
      if (hasPolicyId(g, policy.policyId)) throw new TypeError('duplicate policy');
      if (variant === 'food-subsidy') {
        if (p.commodity !== 'grain' || !state.commodities.some((item) => item.id === p.commodity))
          throw new TypeError('food subsidy requires the grain commodity');
        policy = { ...policy, commodity: p.commodity, spent: 0 };
      }
      const institution = institutions[k.kingdomId];
      if (institution) {
        const decision = decideInstitutionalPolicy({
          institution,
          legitimacy: (p as typeof p & { legitimacy: number }).legitimacy,
          quorum: (p as typeof p & { quorum: number }).quorum,
          support: (p as typeof p & { support: number }).support,
          oppositionVeto: (p as typeof p & { oppositionVeto: boolean }).oppositionVeto,
        });
        if (!decision.approved) throw new TypeError('institution rejected policy');
        const effectiveTick = Math.max(
          policy.effectiveTick,
          engine.getState().tick + 1 + decision.effectiveDelay,
        );
        const delay = effectiveTick - policy.effectiveTick;
        if (effectiveTick > policy.expiryTick && !defaultExpiry)
          throw new TypeError('institutional delay exceeds policy expiry');
        policy = {
          ...policy,
          effectiveTick,
          ...(defaultExpiry ? { expiryTick: policy.expiryTick + delay } : {}),
        };
        g.authorityDecisions.push({
          kingdomId: k.kingdomId,
          policyId: policy.policyId,
          tick: engine.getState().tick + 1,
          decision,
        });
      }
      if (variant === 'food-subsidy') {
        if (
          g.policies.some(
            (existing) =>
              existing.variant === 'food-subsidy' &&
              existing.recipientKingdomId === policy.recipientKingdomId &&
              existing.recipientOwnerId === policy.recipientOwnerId &&
              existing.recipientAccountId === policy.recipientAccountId &&
              existing.commodity === policy.commodity &&
              policy.effectiveTick <= existing.expiryTick &&
              existing.effectiveTick <= policy.expiryTick,
          )
        )
          throw new TypeError('overlapping food subsidy for cohort and commodity');
        const treasury = state.accounts.find((account) => account.id === k.treasuryAccountId)!;
        if (!canReserveFoodGuarantee(g.policies, policy, treasury.balance)) {
          g.decisions.push({
            kingdomId: k.kingdomId,
            policyId: policy.policyId,
            tick: engine.getState().tick + 1,
            selected: 'reject',
            cause: 'funded guarantee validation',
            reason: `insufficient treasury for guarantee: overlapping commitments require available ${treasury.balance}, candidate ${policy.amount}`,
            alternatives: ['approve', 'reject'],
            information: [`treasury=${treasury.balance}`, `guarantee=${policy.amount}`],
            constraints: [
              'overlapping guarantees must be fully backed; treasury cannot be overdrawn',
            ],
          });
          return;
        }
      }
      g.policies.push(policy);
    } catch {
      throw new DomainCommandRejection();
    }
  });
  engine.registerPhaseSystem('infrastructure', 'government:capital-investments', (d) => {
    const g = d.government as GovernmentState | undefined;
    const cities = d.cities as
      { cities?: Record<string, { serviceCapacity: Record<string, number> }> } | undefined;
    if (!g) return;
    const tick = engine.getState().tick + 1;
    for (const investment of g.investments) {
      if (investment.routeId) {
        if (
          !investment.applied &&
          tick >= investment.effectiveTick &&
          tick <= investment.expiryTick
        )
          investment.applied = true;
        if (investment.applied && !investment.expired && tick > investment.expiryTick)
          investment.expired = true;
        continue;
      }
      if (!investment.service) throw new TypeError('service investment missing service');
      const city = cities?.cities?.[investment.cityId];
      if (!city) throw new TypeError('capital investment city disappeared');
      if (
        !investment.applied &&
        tick >= investment.effectiveTick &&
        tick <= investment.expiryTick
      ) {
        const capacity = city.serviceCapacity[investment.service];
        if (!Number.isSafeInteger(capacity) || capacity! > 1000 - investment.capacityIncrease)
          throw new RangeError('capital service capacity bound exceeded');
        city.serviceCapacity[investment.service] = capacity! + investment.capacityIncrease;
        investment.applied = true;
      }
      if (investment.applied && !investment.expired && tick > investment.expiryTick) {
        const capacity = city.serviceCapacity[investment.service];
        if (!Number.isSafeInteger(capacity) || capacity! < investment.capacityIncrease)
          throw new RangeError('capital service capacity rollback mismatch');
        city.serviceCapacity[investment.service] = capacity! - investment.capacityIncrease;
        investment.expired = true;
      }
    }
  });
  engine.registerPhaseSystem('settlement', 'government:autonomous-policy', (d) => {
    const g = d.government as GovernmentState | undefined;
    let accounting = d.accounting as AccountingState | undefined;
    if (!g || !accounting) return;
    const tick = engine.getState().tick + 1;
    for (const k of g.kingdoms.filter((item) => item.controller === 'ai' && item.aiPolicy)) {
      const rule = k.aiPolicy!,
        treasury = accounting.accounts.find(
          (a) => a.id === k.treasuryAccountId && a.ownerId === k.kingdomId,
        ),
        recipient = accounting.accounts.find(
          (a) => a.id === rule.recipientAccountId && a.ownerId === rule.recipientOwnerId,
        );
      const balance = treasury?.balance ?? 0,
        guaranteeReserve = reservedFoodGuarantee(g.policies, k.kingdomId, tick),
        amount = Math.min(rule.amount, Math.max(0, balance - rule.reserve - guaranteeReserve));
      const policyId = `ai-${k.kingdomId}-transfer-${tick}`;
      const selected =
        amount > 0 &&
        recipient &&
        allowed(k, k.kingdomId, rule.recipientOwnerId, rule.recipientAccountId)
          ? 'fund'
          : 'retain';
      g.decisions.push({
        kingdomId: k.kingdomId,
        policyId,
        tick,
        selected,
        alternatives: ['fund', 'retain'],
        cause: 'deterministic treasury-and-reserve rule',
        information: [`treasury=${balance}`, `recipient=${recipient?.id ?? 'missing'}`],
        constraints: [`reserve=${rule.reserve}`, `food guarantees=${guaranteeReserve}`],
        reason:
          selected === 'fund'
            ? `funded amount ${amount} while preserving reserve`
            : 'insufficient spendable treasury or recipient unavailable',
      });
      if (selected === 'fund') {
        const policy = {
          policyId,
          governmentId: k.kingdomId,
          recipientKingdomId: k.kingdomId,
          recipientOwnerId: rule.recipientOwnerId,
          recipientAccountId: rule.recipientAccountId,
          amount,
          effectiveTick: tick,
          expiryTick: tick,
        };
        g.policies.push(policy);
        const next = applyScheduledTransfer(accounting, policy, tick, k.treasuryAccountId);
        if (next !== accounting) {
          accounting = next;
          d.accounting = accounting;
          g.applied.push(policyId);
        }
      }
    }
    for (const policy of g.policies) {
      if (
        policy.variant === 'food-subsidy' ||
        g.applied.includes(policy.policyId) ||
        tick < policy.effectiveTick ||
        tick > policy.expiryTick
      )
        continue;
      const k = g.kingdoms.find((item) => item.kingdomId === policy.governmentId)!;
      const before = d.accounting as AccountingState;
      const treasury = before.accounts.find((a) => a.id === k.treasuryAccountId)!;
      const foodReserve = reservedFoodGuarantee(g.policies, k.kingdomId, tick);
      const next =
        treasury.balance - foodReserve < policy.amount
          ? before
          : applyScheduledTransfer(before, policy, tick, k.treasuryAccountId);
      g.decisions.push({
        kingdomId: k.kingdomId,
        policyId: policy.policyId,
        tick,
        selected: next === before ? 'retain' : 'fund',
        alternatives: ['fund', 'retain'],
        cause: 'scheduled player policy evaluated against treasury balance',
        information: [`treasury=${treasury.balance}`, `requested amount=${policy.amount}`],
        constraints: [`available balance must cover ${policy.amount}`],
        reason:
          next === before
            ? `insufficient unreserved treasury; ${foodReserve} held for active food guarantees`
            : 'scheduled transfer debited the configured treasury',
      });
      if (next !== before) {
        d.accounting = next;
        g.applied.push(policy.policyId);
      }
    }
  });
}
