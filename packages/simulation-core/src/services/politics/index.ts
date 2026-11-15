import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { applyAccountingTransaction, type AccountingState } from '../accounting/index.js';
import { decideIndependently } from '../agents/index.js';
import { hash } from '../../shared/canonical.js';

export interface SocialGroup {
  id: string;
  producerIds: string[];
  cohortId: string;
  organization: number;
  resources: number;
  realWageBps: number;
  unemploymentBps: number;
  satisfaction: number;
  demand: { wageIncreaseBps: number };
  participationBps: number;
  recoveryTicks: number;
  durationTicks: number;
  workerAccountId?: string;
  employerAccountId?: string;
  employerOwnerId?: string;
  workerOwnerId?: string;
  employerAcceptanceBps?: number;
  actionType?: 'strike' | 'protest';
}
export interface SocialProducer {
  id: string;
}
export interface PoliticsConfig {
  groups: SocialGroup[];
  producers: SocialProducer[];
}
export interface PoliticsImpactPlan {
  capacityBps: number;
  wageIncreaseBps: number;
  expectedTaxEffect: 'none-until-settlement';
  taxLimitation: string;
}
type Status = 'proposed' | 'active' | 'negotiating' | 'resolved' | 'failed' | 'expired';
interface Action {
  id: string;
  groupId: string;
  status: Status;
  proposedTick: number;
  startedTick: number | null;
  negotiationTick: number | null;
  elapsed: number;
  reason: string;
  alternatives: string[];
  selected: string;
  information: string[];
  constraints: string[];
  transitionReasons: string[];
  settlementAmount: number;
  concessionBps: number;
  recoveryElapsed: number;
  actionType: 'strike' | 'protest';
  impactPlan: PoliticsImpactPlan;
}
interface PoliticsState {
  version: 1;
  configDigest: string;
  actions: Action[];
  impactPlans: Record<string, PoliticsImpactPlan>;
  lastSignals: Record<string, string>;
  decisions: Array<{
    agentId: string;
    selected: string;
    alternatives: readonly string[];
    information: readonly string[];
    constraints: readonly string[];
    reason: string;
  }>;
}
const stateOf = (d: Record<string, unknown>) => d.politics as PoliticsState;
const isInt = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;

export function registerPolitics(engine: Engine, config: PoliticsConfig): void {
  const groups = structuredClone(config.groups),
    producers = structuredClone(config.producers);
  const digest = hash(config),
    groupIds = new Set(groups.map((g) => g.id)),
    producerIds = new Set(producers.map((p) => p.id));
  if (
    groupIds.size !== groups.length ||
    producerIds.size !== producers.length ||
    groups.some(
      (g) =>
        !g.id?.trim() ||
        !g.cohortId?.trim() ||
        !Array.isArray(g.producerIds) ||
        !g.producerIds.length ||
        new Set(g.producerIds).size !== g.producerIds.length ||
        g.producerIds.some((id) => !producerIds.has(id)) ||
        ![
          g.organization,
          g.resources,
          g.realWageBps,
          g.unemploymentBps,
          g.satisfaction,
          g.demand?.wageIncreaseBps,
          g.participationBps,
        ].every(Number.isSafeInteger) ||
        g.organization < 0 ||
        g.organization > 100 ||
        g.resources < 0 ||
        g.resources > 100 ||
        g.realWageBps < 0 ||
        g.realWageBps > 10000 ||
        g.unemploymentBps < 0 ||
        g.unemploymentBps > 10000 ||
        g.satisfaction < 0 ||
        g.satisfaction > 100 ||
        g.demand.wageIncreaseBps < 0 ||
        g.demand.wageIncreaseBps > 10000 ||
        g.participationBps < 0 ||
        g.participationBps > 10000 ||
        !isInt(g.recoveryTicks) ||
        g.recoveryTicks < 1 ||
        !isInt(g.durationTicks) ||
        g.durationTicks < 1 ||
        (g.employerAcceptanceBps !== undefined && !isInt(g.employerAcceptanceBps, 10000)) ||
        !['strike', 'protest', undefined].includes(g.actionType) ||
        [g.employerAccountId, g.workerAccountId, g.employerOwnerId, g.workerOwnerId].some(
          (value) => value !== undefined && (typeof value !== 'string' || !value.trim()),
        ),
    ) ||
    producers.some((p) => !p.id?.trim())
  )
    throw new TypeError('invalid social-action configuration');
  const memberships = groups.flatMap((g) => g.producerIds);
  if (new Set(memberships).size !== memberships.length)
    throw new TypeError('producer belongs to multiple social groups');
  const initial: PoliticsState = {
    version: 1,
    configDigest: digest,
    actions: [],
    impactPlans: {},
    lastSignals: {},
    decisions: [],
  };
  engine.registerPhaseSystem('infrastructure', 'politics:decisions', (draft) => {
    if (!draft.politics) draft.politics = structuredClone(initial);
    const state = stateOf(draft);
    if (state.version !== 1 || state.configDigest !== digest)
      throw new TypeError('politics config mismatch');
    const economy = draft.economy as
      | {
          producers?: Record<string, { maxBatches: number; wagePerBatch: number; ownerId: string }>;
          configCohorts?: Record<string, { ownerId: string; accountId: string }>;
        }
      | undefined;
    const cities = draft.cities as
      | {
          cohorts?: Record<
            string,
            {
              linkedEconomyCohortId: string;
              population: number;
              unemployment: number;
              incomeThisTick: number;
            }
          >;
        }
      | undefined;
    if (economy)
      for (const group of groups) {
        if (
          !economy.configCohorts?.[group.cohortId] ||
          group.producerIds.some((id) => !economy.producers?.[id])
        )
          throw new TypeError('social group is not bound to live economy');
        const accounts = (draft.accounting as AccountingState | undefined)?.accounts;
        if (
          group.employerAccountId &&
          group.producerIds.some(
            (id) =>
              accounts?.find((a) => a.id === group.employerAccountId)?.ownerId !==
              economy.producers?.[id]?.ownerId,
          )
        )
          throw new TypeError('employer account must belong to a represented producer');
        if (
          group.workerAccountId &&
          accounts?.find((a) => a.id === group.workerAccountId)?.ownerId !==
            economy.configCohorts[group.cohortId]?.ownerId
        )
          throw new TypeError('worker account must belong to represented cohort');
        if (
          group.employerOwnerId &&
          group.producerIds.some((id) => economy.producers?.[id]?.ownerId !== group.employerOwnerId)
        )
          throw new TypeError('employer owner does not own represented producer');
        if (
          group.workerOwnerId &&
          economy.configCohorts[group.cohortId]?.ownerId !== group.workerOwnerId
        )
          throw new TypeError('worker owner does not own represented cohort');
      }
    const tick = engine.getState().tick + 1;
    state.impactPlans = {};
    for (const group of groups) {
      const liveCohort = Object.values(cities?.cohorts ?? {}).find(
        (c) => c.linkedEconomyCohortId === group.cohortId,
      );
      const live = Boolean(economy && liveCohort);
      const unemploymentBps = live
        ? liveCohort!.population
          ? Number((BigInt(liveCohort!.unemployment) * 10000n) / BigInt(liveCohort!.population))
          : 0
        : group.unemploymentBps;
      const realWageBps = live
        ? liveCohort!.incomeThisTick <= 0
          ? 0
          : Math.min(10000, group.realWageBps)
        : group.realWageBps;
      const satisfaction = live
        ? Object.values(
            (draft.economy as { cohorts?: Record<string, { unmet: Record<string, number> }> })
              .cohorts?.[group.cohortId]?.unmet ?? {},
          ).some((n) => n > 0)
          ? Math.min(group.satisfaction, 35)
          : Math.max(group.satisfaction, 36)
        : group.satisfaction;
      const signal = JSON.stringify([
        group.organization,
        group.resources,
        realWageBps,
        unemploymentBps,
        satisfaction,
        group.demand.wageIncreaseBps,
      ]);
      const action = state.actions.find(
        (x) => x.groupId === group.id && ['proposed', 'active', 'negotiating'].includes(x.status),
      );
      const recovering = state.actions.find(
        (x) =>
          x.groupId === group.id &&
          x.status === 'resolved' &&
          x.recoveryElapsed < group.recoveryTicks,
      );
      if (recovering) {
        recovering.recoveryElapsed++;
        const bps = Math.min(
          10000,
          Math.floor(
            10000 -
              group.participationBps +
              (group.participationBps * recovering.recoveryElapsed) / group.recoveryTicks,
          ),
        );
        for (const id of group.producerIds)
          state.impactPlans[id] = {
            capacityBps: bps,
            wageIncreaseBps: recovering.concessionBps,
            expectedTaxEffect: 'none-until-settlement',
            taxLimitation: 'Tax changes only when existing tax policy settles actual transactions.',
          };
        continue;
      }
      if (action?.status === 'proposed') {
        action.status = 'active';
        action.startedTick = tick;
        action.transitionReasons.push('active: proposal carried into following tick');
      }
      if (
        action?.status === 'negotiating' &&
        action.negotiationTick !== null &&
        tick > action.negotiationTick &&
        action.reason.startsWith('duration limit reached')
      ) {
        action.status = 'expired';
        action.reason = 'maximum action duration elapsed';
        action.transitionReasons.push('expired: duration limit');
        state.lastSignals[group.id] = signal;
        continue;
      }
      if (
        action?.status === 'negotiating' &&
        action.negotiationTick !== null &&
        tick > action.negotiationTick &&
        action.settlementAmount > 0
      ) {
        const accounts = draft.accounting as AccountingState | undefined;
        const payer = accounts?.accounts.find((x) => x.id === group.employerAccountId);
        const recipient = accounts?.accounts.find((x) => x.id === group.workerAccountId);
        const funded =
          action.settlementAmount > 0 &&
          Boolean(
            accounts &&
            payer &&
            recipient &&
            group.employerOwnerId &&
            group.workerOwnerId &&
            payer.id !== recipient.id &&
            payer.ownerId === group.employerOwnerId &&
            recipient.ownerId === group.workerOwnerId &&
            payer.balance >= action.settlementAmount &&
            recipient.balance <= Number.MAX_SAFE_INTEGER - action.settlementAmount,
          );
        const preference = group.employerAcceptanceBps ?? 0;
        const affordability = funded ? 10000 : 0;
        const employer = decideIndependently({
          agentId: `employer:${group.id}`,
          options: [
            { id: 'accept', score: Math.min(preference, affordability) },
            { id: 'refuse', score: 10000 - Math.min(preference, affordability) },
          ],
          information: [
            `requestedAmount=${action.settlementAmount}`,
            `requestedWageIncreaseBps=${action.concessionBps}`,
            `availableBalance=${payer?.balance ?? 0}`,
            `affordable=${funded}`,
          ],
          constraints: ['acceptance is bounded by preference and available counterpart funds'],
        });
        state.decisions.push(employer);
        if (employer.selected !== 'accept') {
          action.status = 'failed';
          action.reason = funded
            ? 'counterparty refused the offer'
            : 'settlement could not be funded';
          action.transitionReasons.push(
            funded
              ? 'failed: employer independently refused'
              : 'failed: insufficient settlement funds',
          );
        } else {
          draft.accounting = applyAccountingTransaction(
            accounts!,
            [
              {
                type: 'payment',
                fromAccountId: payer!.id,
                toAccountId: recipient!.id,
                amount: {
                  kind: 'money',
                  currencyId: accounts!.currency.id,
                  unit: accounts!.currency.unit,
                  scale: accounts!.currency.scale,
                  minor: action.settlementAmount,
                },
                causeId: `social-settlement:${action.id}`,
              },
            ],
            `social-settlement:${action.id}`,
          );
          action.status = 'resolved';
          action.reason = 'counterparty accepted a funded settlement';
          action.transitionReasons.push('resolved: employer accepted funded offer');
        }
      }
      if (action && ['active', 'negotiating'].includes(action.status)) {
        action.elapsed++;
        if (action.elapsed > group.durationTicks) {
          if (action.status === 'active') {
            action.status = 'negotiating';
            action.negotiationTick = tick;
            action.reason = 'duration limit reached; awaiting final counterpart decision';
            action.transitionReasons.push('negotiating: duration limit reached');
          } else {
            action.status = 'expired';
            action.reason = 'maximum action duration elapsed';
            action.transitionReasons.push('expired: duration limit');
          }
          state.lastSignals[group.id] = signal;
          continue;
        }
        action.impactPlan = {
          capacityBps: action.actionType === 'strike' ? 10000 - group.participationBps : 10000,
          wageIncreaseBps: 0,
          expectedTaxEffect: 'none-until-settlement',
          taxLimitation: 'Tax changes only when existing tax policy settles actual transactions.',
        };
        for (const id of group.producerIds) state.impactPlans[id] = { ...action.impactPlan };
        continue;
      }
      if (state.lastSignals[group.id] === signal) continue;
      const hardship = [realWageBps < 8500, unemploymentBps >= 1500, satisfaction <= 35].filter(
        Boolean,
      ).length;
      const eligible =
        group.organization >= 50 &&
        group.resources >= 10 &&
        hardship >= 2 &&
        group.demand.wageIncreaseBps > 0;
      const decision = decideIndependently({
        agentId: `group:${group.id}`,
        options: [
          {
            id: 'propose',
            score: eligible ? group.organization + group.resources + hardship * 20 : -1,
          },
          { id: 'wait', score: eligible ? 0 : 1 },
        ],
        information: [
          `organization=${group.organization}`,
          `resources=${group.resources}`,
          `realWageBps=${realWageBps}`,
          `unemploymentBps=${unemploymentBps}`,
          `satisfaction=${satisfaction}`,
          `signals=${live ? 'live economy/city' : 'static fixture fallback'}`,
        ],
        constraints: [
          'requires organization>=50',
          'requires resources>=10',
          'requires at least two hardship signals',
        ],
      });
      state.decisions.push(decision);
      state.lastSignals[group.id] = signal;
      if (decision.selected === 'propose')
        state.actions.push({
          id: `social-${group.id}-${tick}`,
          groupId: group.id,
          status: 'proposed',
          proposedTick: tick,
          startedTick: null,
          negotiationTick: null,
          elapsed: 0,
          reason: 'organized group selected collective action from multiple hardship signals',
          alternatives: [...decision.alternatives],
          selected: decision.selected,
          information: [...decision.information],
          constraints: [...decision.constraints],
          transitionReasons: ['proposed: group chose collective action'],
          settlementAmount: 0,
          concessionBps: 0,
          recoveryElapsed: 0,
          actionType: group.actionType ?? 'strike',
          impactPlan: {
            capacityBps: 10000,
            wageIncreaseBps: 0,
            expectedTaxEffect: 'none-until-settlement',
            taxLimitation: 'Tax changes only when existing tax policy settles actual transactions.',
          },
        });
    }
  });
  engine.registerCommandHandler('politics.negotiate', (draft, payload) => {
    const p = payload as {
      actionId?: unknown;
      decision?: unknown;
      amount?: unknown;
      wageIncreaseBps?: unknown;
    };
    const state = draft.politics as PoliticsState | undefined;
    const action = state?.actions.find((x) => x.id === p?.actionId && x.status === 'active');
    const group = groups.find((x) => x.id === action?.groupId);
    const amount = p?.amount,
      bps = p?.wageIncreaseBps ?? 0;
    if (
      !action ||
      !group ||
      !['offer', 'counter'].includes(String(p.decision)) ||
      !isInt(amount) ||
      !isInt(bps, group.demand.wageIncreaseBps) ||
      (group.demand.wageIncreaseBps > 0 && (amount === 0 || bps === 0))
    )
      throw new DomainCommandRejection();
    const accounting = draft.accounting as AccountingState | undefined;
    const payer = accounting?.accounts.find((x) => x.id === group.employerAccountId);
    const recipient = accounting?.accounts.find((x) => x.id === group.workerAccountId);
    if (
      !accounting ||
      !payer ||
      !recipient ||
      !group.employerOwnerId ||
      !group.workerOwnerId ||
      payer.id === recipient.id ||
      payer.ownerId !== group.employerOwnerId ||
      recipient.ownerId !== group.workerOwnerId ||
      payer.ownerId === recipient.ownerId
    )
      throw new DomainCommandRejection();
    action.status = 'negotiating';
    action.negotiationTick = engine.getState().tick + 1;
    action.settlementAmount = amount;
    action.concessionBps = bps;
    action.reason = 'offer submitted for independent employer decision';
    action.transitionReasons.push('negotiating: offer awaits employer decision');
  });
  engine.registerInvariant((d) => {
    const s = d.politics as PoliticsState | undefined;
    if (!s) return;
    if (
      s.version !== 1 ||
      s.configDigest !== digest ||
      !Array.isArray(s.actions) ||
      !Array.isArray(s.decisions) ||
      !s.impactPlans ||
      !s.lastSignals ||
      new Set(s.actions.map((a) => a?.id)).size !== s.actions.length
    )
      throw new TypeError('invalid politics state');
    const actions = new Map<string, Action>();
    for (const action of s.actions) {
      const group = groups.find((g) => g.id === action.groupId);
      if (
        !group ||
        typeof action.id !== 'string' ||
        !action.id.trim() ||
        !['proposed', 'active', 'negotiating', 'resolved', 'failed', 'expired'].includes(
          action.status,
        ) ||
        !isInt(action.proposedTick) ||
        (action.negotiationTick !== null && !isInt(action.negotiationTick)) ||
        (action.status === 'negotiating' && action.negotiationTick === null) ||
        !isInt(action.elapsed, group.durationTicks + 1) ||
        !isInt(action.settlementAmount) ||
        !isInt(action.concessionBps, group.demand.wageIncreaseBps) ||
        !isInt(action.recoveryElapsed, group.recoveryTicks) ||
        !['strike', 'protest'].includes(action.actionType) ||
        !Array.isArray(action.alternatives) ||
        !Array.isArray(action.information) ||
        !Array.isArray(action.constraints) ||
        !Array.isArray(action.transitionReasons) ||
        typeof action.reason !== 'string' ||
        !action.transitionReasons.length ||
        !action.transitionReasons.includes('proposed: group chose collective action') ||
        (action.status === 'active' &&
          !action.transitionReasons.some((reason) => reason.startsWith('active:'))) ||
        (action.status === 'negotiating' &&
          !action.transitionReasons.some((reason) => reason.startsWith('negotiating:'))) ||
        (action.status === 'resolved' &&
          !action.transitionReasons.some((reason) => reason.startsWith('resolved:'))) ||
        (action.status === 'failed' &&
          !action.transitionReasons.some((reason) => reason.startsWith('failed:'))) ||
        (action.status === 'expired' &&
          !action.transitionReasons.some((reason) => reason.startsWith('expired:'))) ||
        (action.status === 'proposed' && action.startedTick !== null) ||
        (action.status !== 'proposed' && !isInt(action.startedTick)) ||
        (action.status === 'resolved' &&
          (action.settlementAmount <= 0 ||
            (group.demand.wageIncreaseBps > 0 && action.concessionBps <= 0))) ||
        (action.status === 'negotiating' &&
          action.settlementAmount <= 0 &&
          !action.reason.startsWith('duration limit reached'))
      )
        throw new TypeError('invalid politics action');
      actions.set(action.id, action);
    }
    for (const [producerId, plan] of Object.entries(s.impactPlans))
      if (
        !producerIds.has(producerId) ||
        !plan ||
        !isInt(plan.capacityBps, 10000) ||
        !isInt(plan.wageIncreaseBps, 10000) ||
        plan.expectedTaxEffect !== 'none-until-settlement' ||
        typeof plan.taxLimitation !== 'string'
      )
        throw new TypeError('invalid politics impact plan');
    const accounting = d.accounting as AccountingState | undefined;
    for (const action of actions.values())
      if (
        action.status === 'resolved' &&
        !accounting?.journal.some((entry) => entry.causeId === `social-settlement:${action.id}`)
      )
        throw new TypeError('resolved politics action lacks settlement journal');
  });
}
export function getPoliticsImpactPlan(
  domain: Readonly<Record<string, unknown>>,
  producerId: string,
): PoliticsImpactPlan | undefined {
  const p = (domain.politics as PoliticsState | undefined)?.impactPlans?.[producerId];
  return p ? { ...p } : undefined;
}
