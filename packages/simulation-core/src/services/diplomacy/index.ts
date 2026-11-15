import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import type { AccountingState } from '../accounting/index.js';
import { hash } from '../../shared/canonical.js';

export interface TradeOffer {
  readonly offerId: string;
  readonly fromKingdomId: string;
  readonly toKingdomId: string;
  readonly routeId: string;
  readonly commodity: string;
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
}
export interface DiplomacyConfig {
  readonly offers: readonly TradeOffer[];
  readonly kingdoms: readonly DiplomacyKingdom[];
  readonly preferences: Readonly<Record<string, DiplomacyPreference>>;
}
type DiplomacyState = {
  version: 2;
  digest: string;
  offers: TradeOffer[];
  kingdoms: DiplomacyKingdom[];
  preferences: Record<string, DiplomacyPreference>;
  decisions: TradePermitDecision[];
};
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const validOffer = (o: TradeOffer) =>
  !!o &&
  text(o.offerId) &&
  text(o.fromKingdomId) &&
  text(o.toKingdomId) &&
  o.fromKingdomId !== o.toKingdomId &&
  text(o.routeId) &&
  text(o.commodity);
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
  d.constraints.every(text);
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
    }),
    digest = hash(safe);
  const initialize = (d: Record<string, unknown>) => {
    if (!d.diplomacy)
      d.diplomacy = {
        version: 2,
        digest,
        ...structuredClone(safe),
        decisions: [],
      } satisfies DiplomacyState;
  };
  engine.registerPhaseSystem('infrastructure', 'diplomacy:initialize', initialize);
  engine.registerInvariant((d) => {
    const s = d.diplomacy as DiplomacyState | undefined;
    if (
      s &&
      (s.version !== 2 ||
        s.digest !== digest ||
        hash({ offers: s.offers, kingdoms: s.kingdoms, preferences: s.preferences }) !== digest ||
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
        state.decisions.push(
          makeDecision(offer, kingdomId, state.preferences[kingdomId]!, accounting),
        );
      }
  };
  engine.registerPhaseSystem('settlement', 'diplomacy:autonomous-decisions', (d) => {
    initialize(d);
    if (d.accounting) decideAi(d.diplomacy as DiplomacyState, d.accounting as AccountingState);
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
      });
    } catch {
      throw new DomainCommandRejection();
    }
  });
}
function makeDecision(
  offer: TradeOffer,
  kingdomId: string,
  preference: DiplomacyPreference,
  a: AccountingState,
): TradePermitDecision {
  const ownerStock = a.stock
    .filter(
      (x) =>
        x.ownerId === kingdomId && x.commodity === offer.commodity && x.location === 'available',
    )
    .reduce((n, x) => n + x.quantity, 0);
  const accounts = a.accounts.filter((x) => x.ownerId === kingdomId),
    treasury = accounts.reduce((n, x) => n + x.balance, 0);
  const accepted = ownerStock >= preference.minimumStock && treasury >= preference.minimumTreasury;
  return {
    offerId: offer.offerId,
    kingdomId,
    accepted,
    alternatives: ['accept', 'refuse'],
    information: [`available ${offer.commodity}=${ownerStock}`, `observable treasury=${treasury}`],
    constraints: [
      `minimum stock=${preference.minimumStock}`,
      `minimum treasury=${preference.minimumTreasury}`,
    ],
    cause: 'deterministic reserve-threshold rule',
    reason: accepted
      ? 'observable reserves satisfy configured trade thresholds'
      : 'observable reserves fail configured trade thresholds',
  };
}
export function hasBilateralTradePermit(
  domain: Readonly<Record<string, unknown>>,
  routeId: string,
  commodity: string,
  fromKingdomId: string,
  toKingdomId: string,
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
        [fromKingdomId, toKingdomId].every((kingdomId) =>
          state.decisions.some(
            (d) => d.offerId === o.offerId && d.kingdomId === kingdomId && d.accepted,
          ),
        ),
    )
  );
}
