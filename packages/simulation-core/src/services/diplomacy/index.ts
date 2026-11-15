import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { applyAccountingTransaction, type AccountingState } from '../accounting/index.js';
import type { MoneyUnit } from '../../models/units.js';
import { hash } from '../../shared/canonical.js';

export interface TradeOffer {
  readonly offerId: string;
  readonly fromKingdomId: string;
  readonly toKingdomId: string;
  readonly routeId: string;
  readonly commodity: string;
  readonly effectiveTick?: number;
  readonly expiryTick?: number;
  readonly quota?: number;
  readonly tariffDiscountBps?: number;
  readonly withdrawalPenalty?: number;
}
export interface DiplomacyKingdom {
  readonly kingdomId: string;
  readonly controller: 'player' | 'ai';
}
export interface DiplomacyPreference {
  readonly minimumTreasury: number;
  readonly minimumStock: number;
}
export interface TradePermitDecision {
  readonly offerId: string;
  readonly kingdomId: string;
  readonly accepted: boolean;
  readonly alternatives: readonly ['accept', 'refuse'];
  readonly information: readonly string[];
  readonly constraints: readonly string[];
  readonly cause: string;
  readonly reason: string;
  readonly scores: Readonly<Record<string, number>>;
}
export interface DiplomacyRelationConfig {
  readonly kingdomA: string;
  readonly kingdomB: string;
  readonly trust: number;
  readonly interests: Readonly<Record<string, number>>;
}
export interface DiplomacyConfig {
  readonly offers: readonly TradeOffer[];
  readonly kingdoms: readonly DiplomacyKingdom[];
  readonly preferences: Readonly<Record<string, DiplomacyPreference>>;
  readonly relations?: readonly DiplomacyRelationConfig[];
}
type DiplomacyState = {
  version: 2;
  digest: string;
  offers: TradeOffer[];
  kingdoms: DiplomacyKingdom[];
  preferences: Record<string, DiplomacyPreference>;
  decisions: TradePermitDecision[];
  withdrawals: Array<{
    offerId: string;
    kingdomId: string;
    effectiveTick: number;
    reason: string;
    causeId: string;
  }>;
  relations: Array<{
    a: string;
    b: string;
    trust: number;
    interests: Record<string, number>;
  }>;
  sanctionDecisions: Array<{
    decisionId: string;
    observedSanctionId: string;
    kingdomId: string;
    choice: 'respond' | 'abstain';
    alternatives: readonly ['respond', 'abstain'];
    information: readonly string[];
    scores: Readonly<Record<string, number>>;
    constraints: readonly string[];
    reason: string;
  }>;
  sanctions: Array<{
    sanctionId: string;
    issuerKingdomId: string;
    targetKingdomId: string;
    routeId: string;
    commodity: string;
    effectiveTick: number;
    expiryTick: number;
    reason: string;
  }>;
};
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const validOffer = (o: TradeOffer) =>
  !!o &&
  text(o.offerId) &&
  text(o.fromKingdomId) &&
  text(o.toKingdomId) &&
  o.fromKingdomId !== o.toKingdomId &&
  text(o.routeId) &&
  text(o.commodity) &&
  ((o.effectiveTick === undefined && o.expiryTick === undefined) ||
    (Number.isSafeInteger(o.effectiveTick) &&
      o.effectiveTick! > 0 &&
      Number.isSafeInteger(o.expiryTick) &&
      o.expiryTick! >= o.effectiveTick!)) &&
  (o.quota === undefined || (Number.isSafeInteger(o.quota) && o.quota > 0)) &&
  (o.tariffDiscountBps === undefined ||
    (Number.isSafeInteger(o.tariffDiscountBps) &&
      o.tariffDiscountBps >= 0 &&
      o.tariffDiscountBps <= 10_000)) &&
  (o.withdrawalPenalty === undefined ||
    (Number.isSafeInteger(o.withdrawalPenalty) && o.withdrawalPenalty >= 0));
const validDecision = (d: TradePermitDecision) =>
  !!d &&
  text(d.offerId) &&
  text(d.kingdomId) &&
  typeof d.accepted === 'boolean' &&
  text(d.cause) &&
  text(d.reason) &&
  Array.isArray(d.information) &&
  d.information.every(text) &&
  Array.isArray(d.constraints) &&
  d.constraints.every(text) &&
  !!d.scores &&
  Object.values(d.scores).every((score) => Number.isSafeInteger(score));
export function registerDiplomacy(engine: Engine, config: DiplomacyConfig): void {
  if (
    !config ||
    !Array.isArray(config.offers) ||
    !Array.isArray(config.kingdoms) ||
    !config.preferences ||
    !config.offers.length ||
    config.offers.some((o) => !validOffer(o)) ||
    new Set(config.offers.map((o) => o.offerId)).size !== config.offers.length ||
    config.kingdoms.length < 2 ||
    config.kingdoms.some(
      (k) => !k || !text(k.kingdomId) || !['player', 'ai'].includes(k.controller),
    ) ||
    config.kingdoms.filter((k) => k.controller === 'player').length !== 1 ||
    new Set(config.kingdoms.map((k) => k.kingdomId)).size !== config.kingdoms.length ||
    config.offers.some(
      (o) =>
        !config.kingdoms.some((k) => k.kingdomId === o.fromKingdomId) ||
        !config.kingdoms.some((k) => k.kingdomId === o.toKingdomId),
    ) ||
    new Set(
      (config.relations ?? []).map((relation) =>
        [relation.kingdomA, relation.kingdomB].sort().join('\\u0000'),
      ),
    ).size !== (config.relations ?? []).length ||
    (config.relations ?? []).some(
      (relation) =>
        !relation ||
        !text(relation.kingdomA) ||
        !text(relation.kingdomB) ||
        relation.kingdomA === relation.kingdomB ||
        !config.kingdoms.some((kingdom) => kingdom.kingdomId === relation.kingdomA) ||
        !config.kingdoms.some((kingdom) => kingdom.kingdomId === relation.kingdomB) ||
        !Number.isSafeInteger(relation.trust) ||
        relation.trust < 0 ||
        relation.trust > 100 ||
        !relation.interests ||
        Object.entries(relation.interests).some(
          ([interest, value]) =>
            !text(interest) || !Number.isSafeInteger(value) || value < 0 || value > 100,
        ),
    ) ||
    config.kingdoms.some(
      (k) =>
        !config.preferences[k.kingdomId] ||
        !Number.isSafeInteger(config.preferences[k.kingdomId]!.minimumTreasury) ||
        config.preferences[k.kingdomId]!.minimumTreasury < 0 ||
        !Number.isSafeInteger(config.preferences[k.kingdomId]!.minimumStock) ||
        config.preferences[k.kingdomId]!.minimumStock < 0,
    )
  )
    throw new TypeError('invalid diplomacy configuration');
  const safe = structuredClone({
      offers: config.offers,
      kingdoms: config.kingdoms,
      preferences: config.preferences,
      relations: config.relations ?? [],
    }),
    digest = hash(safe);
  const initialRelations = safe.relations.length
    ? safe.relations.map((relation) => ({
        a: relation.kingdomA,
        b: relation.kingdomB,
        trust: relation.trust,
        interests: { ...relation.interests },
      }))
    : safe.kingdoms.flatMap((left, index) =>
        safe.kingdoms.slice(index + 1).map((right) => ({
          a: left.kingdomId,
          b: right.kingdomId,
          trust: 50,
          interests: { trade: 50 },
        })),
      );
  const initialize = (d: Record<string, unknown>) => {
    if (!d.diplomacy)
      d.diplomacy = {
        version: 2,
        digest,
        ...structuredClone(safe),
        relations: structuredClone(initialRelations),
        sanctions: [],
        sanctionDecisions: [],
        decisions: [],
        withdrawals: [],
      } satisfies DiplomacyState;
  };
  engine.registerPhaseSystem('infrastructure', 'diplomacy:initialize', initialize);
  engine.registerInvariant((d) => {
    const s = d.diplomacy as DiplomacyState | undefined;
    if (
      s &&
      (s.version !== 2 ||
        s.digest !== digest ||
        hash({
          offers: s.offers,
          kingdoms: s.kingdoms,
          preferences: s.preferences,
          relations: config.relations ?? [],
        }) !== digest ||
        !Array.isArray(s.relations) ||
        s.relations.some(
          (relation) =>
            !text(relation.a) ||
            !text(relation.b) ||
            relation.a === relation.b ||
            !s.kingdoms.some((kingdom) => kingdom.kingdomId === relation.a) ||
            !s.kingdoms.some((kingdom) => kingdom.kingdomId === relation.b) ||
            !Number.isSafeInteger(relation.trust) ||
            relation.trust < 0 ||
            relation.trust > 100 ||
            !relation.interests ||
            Object.entries(relation.interests).some(
              ([key, value]) =>
                !text(key) || !Number.isSafeInteger(value) || value < 0 || value > 100,
            ),
        ) ||
        new Set(s.relations.map((relation) => [relation.a, relation.b].sort().join('\\u0000')))
          .size !== s.relations.length ||
        !Array.isArray(s.sanctionDecisions) ||
        s.sanctionDecisions.some(
          (decision) =>
            !text(decision.decisionId) ||
            !s.sanctions.some((sanction) => sanction.sanctionId === decision.observedSanctionId) ||
            !s.kingdoms.some(
              (kingdom) => kingdom.kingdomId === decision.kingdomId && kingdom.controller === 'ai',
            ) ||
            !['respond', 'abstain'].includes(decision.choice) ||
            !Array.isArray(decision.alternatives) ||
            !decision.alternatives.includes('respond') ||
            !decision.alternatives.includes('abstain') ||
            !Array.isArray(decision.information) ||
            !decision.information.every(text) ||
            !Array.isArray(decision.constraints) ||
            !decision.constraints.every(text) ||
            !text(decision.reason) ||
            !decision.scores ||
            Object.values(decision.scores).some((score) => !Number.isSafeInteger(score)),
        ) ||
        new Set(s.sanctionDecisions.map((decision) => decision.decisionId)).size !==
          s.sanctionDecisions.length ||
        !Array.isArray(s.sanctions) ||
        s.sanctions.some(
          (sanction) =>
            !text(sanction.sanctionId) ||
            !s.kingdoms.some((kingdom) => kingdom.kingdomId === sanction.issuerKingdomId) ||
            !s.kingdoms.some((kingdom) => kingdom.kingdomId === sanction.targetKingdomId) ||
            sanction.issuerKingdomId === sanction.targetKingdomId ||
            !text(sanction.routeId) ||
            !text(sanction.commodity) ||
            !Number.isSafeInteger(sanction.effectiveTick) ||
            sanction.effectiveTick < 1 ||
            !Number.isSafeInteger(sanction.expiryTick) ||
            sanction.expiryTick < sanction.effectiveTick ||
            !text(sanction.reason),
        ) ||
        new Set(s.sanctions.map((sanction) => sanction.sanctionId)).size !== s.sanctions.length ||
        !Array.isArray(s.withdrawals) ||
        s.withdrawals.some(
          (withdrawal) =>
            !s.offers.some((offer) => offer.offerId === withdrawal.offerId) ||
            ![
              withdrawal.kingdomId,
              s.offers.find((offer) => offer.offerId === withdrawal.offerId)?.fromKingdomId,
              s.offers.find((offer) => offer.offerId === withdrawal.offerId)?.toKingdomId,
            ].every((kingdomId) =>
              s.decisions.some(
                (decision) =>
                  decision.offerId === withdrawal.offerId &&
                  decision.kingdomId === kingdomId &&
                  decision.accepted,
              ),
            ) ||
            !s.kingdoms.some(
              (kingdom) =>
                kingdom.kingdomId === withdrawal.kingdomId &&
                kingdom.controller === 'player' &&
                [
                  s.offers.find((offer) => offer.offerId === withdrawal.offerId)?.fromKingdomId,
                  s.offers.find((offer) => offer.offerId === withdrawal.offerId)?.toKingdomId,
                ].includes(kingdom.kingdomId),
            ) ||
            !Number.isSafeInteger(withdrawal.effectiveTick) ||
            withdrawal.effectiveTick < 1 ||
            !text(withdrawal.reason) ||
            !text(withdrawal.causeId),
        ) ||
        new Set(s.withdrawals.map((withdrawal) => withdrawal.offerId)).size !==
          s.withdrawals.length ||
        !Array.isArray(s.decisions) ||
        s.decisions.some((x) => !validDecision(x)))
    )
      throw new TypeError('invalid diplomacy state');
    const government = d.government as
      { kingdoms?: Array<{ kingdomId: string; controller: 'player' | 'ai' }> } | undefined;
    if (
      s &&
      government &&
      (!Array.isArray(government.kingdoms) ||
        government.kingdoms.length !== s.kingdoms.length ||
        s.kingdoms.some(
          (kingdom) =>
            government.kingdoms!.find((item) => item.kingdomId === kingdom.kingdomId)
              ?.controller !== kingdom.controller,
        ))
    )
      throw new TypeError('government and diplomacy kingdom roles do not match');
  });
  const decideAi = (state: DiplomacyState, accounting: AccountingState) => {
    for (const offer of state.offers)
      for (const kingdomId of [offer.fromKingdomId, offer.toKingdomId]) {
        if (state.decisions.some((d) => d.offerId === offer.offerId && d.kingdomId === kingdomId))
          continue;
        const controller = state.kingdoms.find((k) => k.kingdomId === kingdomId)!.controller;
        if (controller !== 'ai') continue;
        const decision = makeDecision(
          offer,
          kingdomId,
          state.preferences[kingdomId]!,
          accounting,
          state,
        );
        state.decisions.push(decision);
        adjustTrust(state, offer.fromKingdomId, offer.toKingdomId, decision.accepted ? 1 : -1);
      }
  };
  engine.registerPhaseSystem('settlement', 'diplomacy:autonomous-decisions', (d) => {
    initialize(d);
    if (d.accounting) {
      const state = d.diplomacy as DiplomacyState;
      decideAi(state, d.accounting as AccountingState);
      decideSanctionResponses(state, d);
    }
  });
  engine.registerCommandHandler('diplomacy.sanction', (d, payload) => {
    try {
      initialize(d);
      const p = payload as Record<string, unknown>;
      const s = d.diplomacy as DiplomacyState;
      const issuer = s.kingdoms.find((kingdom) => kingdom.kingdomId === p?.issuerKingdomId);
      if (
        !issuer ||
        issuer.controller !== 'player' ||
        !text(p?.sanctionId) ||
        !text(p?.targetKingdomId) ||
        p.targetKingdomId === p.issuerKingdomId ||
        !s.kingdoms.some((kingdom) => kingdom.kingdomId === p.targetKingdomId) ||
        !text(p?.routeId) ||
        !text(p?.commodity) ||
        !Number.isSafeInteger(p?.effectiveTick) ||
        (p.effectiveTick as number) < 1 ||
        !Number.isSafeInteger(p?.expiryTick) ||
        (p.expiryTick as number) < (p.effectiveTick as number) ||
        !text(p?.reason) ||
        s.sanctions.some((sanction) => sanction.sanctionId === p.sanctionId)
      )
        throw new TypeError('invalid or unauthorized targeted sanction');
      s.sanctions.push({
        sanctionId: p.sanctionId,
        issuerKingdomId: p.issuerKingdomId as string,
        targetKingdomId: p.targetKingdomId as string,
        routeId: p.routeId as string,
        commodity: p.commodity as string,
        effectiveTick: p.effectiveTick as number,
        expiryTick: p.expiryTick as number,
        reason: p.reason as string,
      });
    } catch {
      throw new DomainCommandRejection();
    }
  });
  engine.registerCommandHandler('diplomacy.withdrawal', (d, payload) => {
    try {
      initialize(d);
      const p = payload as {
        offerId?: unknown;
        kingdomId?: unknown;
        effectiveTick?: unknown;
        reason?: unknown;
      };
      const s = d.diplomacy as DiplomacyState;
      const offer = s.offers.find((item) => item.offerId === p?.offerId);
      const actor = s.kingdoms.find((item) => item.kingdomId === p?.kingdomId);
      const currentTick = (d.logistics as { tick?: number } | undefined)?.tick ?? 0;
      if (
        !offer ||
        !actor ||
        actor.controller !== 'player' ||
        ![offer.fromKingdomId, offer.toKingdomId].includes(actor.kingdomId) ||
        !Number.isSafeInteger(p?.effectiveTick) ||
        (p.effectiveTick as number) <= currentTick ||
        !text(p?.reason) ||
        s.withdrawals.some((withdrawal) => withdrawal.offerId === offer.offerId) ||
        ![offer.fromKingdomId, offer.toKingdomId].every((kingdomId) =>
          s.decisions.some(
            (decision) =>
              decision.offerId === offer.offerId &&
              decision.kingdomId === kingdomId &&
              decision.accepted,
          ),
        )
      )
        throw new TypeError('invalid or unauthorized treaty withdrawal');
      const effectiveTick = p.effectiveTick as number;
      const early = effectiveTick < (offer.expiryTick ?? Number.MAX_SAFE_INTEGER);
      const penalty = early ? (offer.withdrawalPenalty ?? 0) : 0;
      const causeId = `diplomacy:withdrawal:${offer.offerId}`;
      if (penalty > 0) {
        const accounting = d.accounting as AccountingState | undefined;
        if (!accounting) throw new TypeError('accounting is required for withdrawal penalty');
        const payerId = actor.kingdomId;
        const counterpartyId =
          offer.fromKingdomId === payerId ? offer.toKingdomId : offer.fromKingdomId;
        const government = d.government as
          { kingdoms?: Array<{ kingdomId: string; treasuryAccountId: string }> } | undefined;
        const treasuryId = (kingdomId: string) => {
          const configured = government?.kingdoms?.find(
            (item) => item.kingdomId === kingdomId,
          )?.treasuryAccountId;
          if (configured) return configured;
          const owned = accounting.accounts.filter((account) => account.ownerId === kingdomId);
          const named = owned.filter((account) => account.id === `${kingdomId}-treasury`);
          if (named.length === 1) return named[0]!.id;
          if (owned.length === 1) return owned[0]!.id;
          throw new TypeError('unambiguous treasury account required for withdrawal penalty');
        };
        const payerTreasuryId = treasuryId(payerId);
        const counterpartyTreasuryId = treasuryId(counterpartyId);
        if (
          accounting.accounts.find((account) => account.id === payerTreasuryId)?.ownerId !==
            payerId ||
          accounting.accounts.find((account) => account.id === counterpartyTreasuryId)?.ownerId !==
            counterpartyId
        )
          throw new TypeError('treasury account owner does not match treaty party');
        const currency = accounting.currency;
        d.accounting = applyAccountingTransaction(
          accounting,
          [
            {
              type: 'payment',
              fromAccountId: payerTreasuryId,
              toAccountId: counterpartyTreasuryId,
              amount: {
                kind: 'money',
                currencyId: currency.id,
                unit: currency.unit,
                scale: currency.scale,
                minor: penalty,
              } satisfies MoneyUnit,
              causeId,
            },
          ],
          causeId,
        );
      }
      s.withdrawals.push({
        offerId: offer.offerId,
        kingdomId: actor.kingdomId,
        effectiveTick,
        reason: p.reason,
        causeId,
      });
    } catch {
      throw new DomainCommandRejection();
    }
  });
  engine.registerCommandHandler('diplomacy.decision', (d, payload) => {
    try {
      initialize(d);
      const p = payload as {
        offerId?: unknown;
        kingdomId?: unknown;
        accepted?: unknown;
        reason?: unknown;
      };
      const s = d.diplomacy as DiplomacyState,
        offer = s.offers.find((o) => o.offerId === p?.offerId),
        actor = s.kingdoms.find((k) => k.kingdomId === p?.kingdomId);
      if (
        !offer ||
        !actor ||
        actor.controller !== 'player' ||
        ![offer.fromKingdomId, offer.toKingdomId].includes(actor.kingdomId) ||
        typeof p?.accepted !== 'boolean' ||
        typeof p.reason !== 'string' ||
        !p.reason.trim() ||
        s.decisions.some((x) => x.offerId === offer.offerId && x.kingdomId === actor.kingdomId)
      )
        throw new TypeError('invalid or unauthorized diplomacy decision');
      s.decisions.push({
        offerId: offer.offerId,
        kingdomId: actor.kingdomId,
        accepted: p.accepted,
        alternatives: ['accept', 'refuse'],
        information: ['player-controlled explicit choice'],
        constraints: ['one decision per offer and kingdom'],
        cause: 'explicit player command',
        reason: p.reason,
        scores: { playerChoice: p.accepted ? 1 : 0 },
      });
      adjustTrust(s, offer.fromKingdomId, offer.toKingdomId, p.accepted ? 2 : -2);
    } catch {
      throw new DomainCommandRejection();
    }
  });
}
function adjustTrust(state: DiplomacyState, a: string, b: string, delta: number): void {
  const relation = state.relations.find(
    (item) => (item.a === a && item.b === b) || (item.a === b && item.b === a),
  );
  if (relation) relation.trust = Math.max(0, Math.min(100, relation.trust + delta));
}
function decideSanctionResponses(state: DiplomacyState, domain: Record<string, unknown>): void {
  const currentTick = (domain.logistics as { tick?: number } | undefined)?.tick ?? 0;
  for (const observed of state.sanctions) {
    const issuer = state.kingdoms.find((kingdom) => kingdom.kingdomId === observed.issuerKingdomId);
    const victim = state.kingdoms.find((kingdom) => kingdom.kingdomId === observed.targetKingdomId);
    if (issuer?.controller !== 'player' || victim?.controller !== 'ai') continue;
    const decisionId = `diplomacy:response:${observed.sanctionId}:${observed.targetKingdomId}`;
    if (state.sanctionDecisions.some((decision) => decision.decisionId === decisionId)) continue;
    const relation = state.relations.find(
      (item) =>
        (item.a === observed.issuerKingdomId && item.b === observed.targetKingdomId) ||
        (item.b === observed.issuerKingdomId && item.a === observed.targetKingdomId),
    );
    const trust = relation?.trust ?? 50;
    const interest = relation?.interests[observed.commodity] ?? 50;
    const logistics = domain.logistics as
      | {
          routes?: Array<{ routeId: string; sourceCityId: string; destinationCityId: string }>;
          cityKingdomIds?: Record<string, string>;
        }
      | undefined;
    const oppositeRoute = logistics?.routes
      ?.filter(
        (route) =>
          logistics.cityKingdomIds?.[route.sourceCityId] === observed.targetKingdomId &&
          logistics.cityKingdomIds?.[route.destinationCityId] === observed.issuerKingdomId,
      )
      .sort((left, right) => left.routeId.localeCompare(right.routeId))[0];
    const respondScore = 100 - trust + interest;
    const choice =
      respondScore >= 125 && observed.expiryTick >= currentTick && oppositeRoute
        ? 'respond'
        : 'abstain';
    const reason =
      choice === 'respond'
        ? 'bounded bilateral trust and commodity interest favor a targeted response on the configured opposite route'
        : 'bounded trust, commodity interest, response window, or opposite-route availability does not justify response';
    state.sanctionDecisions.push({
      decisionId,
      observedSanctionId: observed.sanctionId,
      kingdomId: observed.targetKingdomId,
      choice,
      alternatives: ['respond', 'abstain'],
      information: [
        `bilateral trust=${trust}`,
        `${observed.commodity} interest=${interest}`,
        `observed expiry=${observed.expiryTick}`,
      ],
      scores: { respond: respondScore, abstain: 125 },
      constraints: [
        'respond score must be at least 125',
        'a configured reverse-direction route is required',
        'counter-sanction is limited to the selected route and observed window',
      ],
      reason,
    });
    if (choice === 'respond' && oppositeRoute) {
      state.sanctions.push({
        sanctionId: `diplomacy:counter:${observed.sanctionId}:${observed.targetKingdomId}`,
        issuerKingdomId: observed.targetKingdomId,
        targetKingdomId: observed.issuerKingdomId,
        routeId: oppositeRoute.routeId,
        commodity: observed.commodity,
        effectiveTick: Math.max(currentTick, observed.effectiveTick),
        expiryTick: observed.expiryTick,
        reason: `independent response to ${observed.sanctionId}`,
      });
    }
    adjustTrust(
      state,
      observed.issuerKingdomId,
      observed.targetKingdomId,
      choice === 'respond' ? -5 : -1,
    );
  }
}
function makeDecision(
  offer: TradeOffer,
  kingdomId: string,
  preference: DiplomacyPreference,
  a: AccountingState,
  state: DiplomacyState,
): TradePermitDecision {
  const ownerStock = a.stock
    .filter(
      (x) =>
        x.ownerId === kingdomId && x.commodity === offer.commodity && x.location === 'available',
    )
    .reduce((n, x) => n + x.quantity, 0);
  const accounts = a.accounts.filter((x) => x.ownerId === kingdomId),
    treasury = accounts.reduce((n, x) => n + x.balance, 0);
  const reserveSatisfied =
    ownerStock >= preference.minimumStock && treasury >= preference.minimumTreasury;
  const relation = state.relations.find(
    (item) =>
      (item.a === offer.fromKingdomId && item.b === offer.toKingdomId) ||
      (item.b === offer.fromKingdomId && item.a === offer.toKingdomId),
  );
  const trust = relation?.trust ?? 50;
  const interest = relation?.interests[offer.commodity] ?? relation?.interests.trade ?? 50;
  const reserveScore = reserveSatisfied ? 100 : 0;
  const utilityScore = reserveScore + trust - 50 + interest - 50;
  const accepted = utilityScore >= 100;
  return {
    offerId: offer.offerId,
    kingdomId,
    accepted,
    alternatives: ['accept', 'refuse'],
    information: [`available ${offer.commodity}=${ownerStock}`, `observable treasury=${treasury}`],
    constraints: [
      `minimum stock=${preference.minimumStock}`,
      `minimum treasury=${preference.minimumTreasury}`,
      'accept score must be at least 100',
    ],
    cause: 'deterministic bilateral reserve, trust, and commodity utility rule',
    reason: accepted
      ? 'observable reserves and bilateral trade utility meet the acceptance threshold'
      : 'observable reserves and bilateral trade utility do not meet the acceptance threshold',
    scores: { accept: utilityScore, refuse: 100 },
  };
}
export function hasBilateralTradePermit(
  domain: Readonly<Record<string, unknown>>,
  routeId: string,
  commodity: string,
  fromKingdomId: string,
  toKingdomId: string,
  tick = Number.MAX_SAFE_INTEGER,
): boolean {
  const state = domain.diplomacy as DiplomacyState | undefined;
  return (
    !!state &&
    state.offers.some(
      (o) =>
        o.routeId === routeId &&
        o.commodity === commodity &&
        o.fromKingdomId === fromKingdomId &&
        o.toKingdomId === toKingdomId &&
        (o.effectiveTick === undefined || tick >= o.effectiveTick) &&
        (o.expiryTick === undefined || tick <= o.expiryTick) &&
        !state.withdrawals.some(
          (withdrawal) => withdrawal.offerId === o.offerId && tick >= withdrawal.effectiveTick,
        ) &&
        [fromKingdomId, toKingdomId].every((kingdomId) =>
          state.decisions.some(
            (d) => d.offerId === o.offerId && d.kingdomId === kingdomId && d.accepted,
          ),
        ),
    )
  );
}
