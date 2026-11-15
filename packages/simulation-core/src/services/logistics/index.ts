import type { Engine } from '../engine.js';
import {
  applyAccountingTransaction,
  createAccountingState,
  type AccountingConfig,
  type AccountingOperation,
  type AccountingState,
} from '../accounting/index.js';
import { DomainCommandRejection } from '../../models/commands.js';
import type { CommodityQuantity, MoneyUnit } from '../../models/units.js';
import { hash } from '../../shared/canonical.js';
import { hasBilateralTradePermit } from '../diplomacy/index.js';
import {
  activeOutwardElapsedTicks,
  isPaidObstructionRerouteEligible,
  pauseRouteShipment,
  returnDueTick,
  resumeRouteShipment,
} from './route-rules.js';

export interface LogisticsRoute {
  readonly routeId: string;
  readonly sourceCityId: string;
  readonly destinationCityId: string;
  readonly travelTicks: number;
  readonly capacity: number;
  readonly fare: number;
  readonly carrierAccountId: string;
}
export interface LogisticsConfig extends Omit<AccountingConfig, 'stock'> {
  readonly stock?: AccountingConfig['stock'];
  readonly transitOwnerId: string;
  readonly cities: readonly string[];
  readonly cityOwnerIds?: Readonly<Record<string, string>>;
  /** Authoritative city-to-kingdom mapping for cross-kingdom shipment consent. */
  readonly cityKingdomIds?: Readonly<Record<string, string>>;
  readonly routes: readonly LogisticsRoute[];
}
type Status = 'in-transit' | 'arrived' | 'returning' | 'returned';
type Shipment = {
  shipmentId: string;
  routeId: string;
  commodity: string;
  quantity: number;
  departureTick: number;
  arrivalTick: number;
  status: Status;
  buyerAccountId: string;
  carrierAccountId: string;
  payment: number;
  treatyOfferId?: string;
  attackTick?: number;
  returnDueTick?: number;
  pausedRemainingTicks?: number;
  blockedAtTick?: number;
  blockReturnTick?: number;
  blockReturnElapsedTicks?: number;
  reroutedFromRouteId?: string;
  reroutedAtTick?: number;
  rerouteRemainingTicks?: number;
  rerouteOriginalDepartureTick?: number;
  rerouteOriginalArrivalTick?: number;
  rerouteBlockedAtTick?: number;
};
type LogisticsState = {
  version: 1;
  configDigest: string;
  tick: number;
  routes: LogisticsRoute[];
  cityKingdomIds?: Record<string, string>;
  shipments: Shipment[];
  closedRouteIds: string[];
  blockedRouteIds: string[];
  attackedRouteIds: string[];
};
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const money = (a: AccountingState, minor: number): MoneyUnit => ({
  kind: 'money',
  currencyId: a.currency.id,
  unit: a.currency.unit,
  scale: a.currency.scale,
  minor,
});
const quantity = (a: AccountingState, id: string, value: number): CommodityQuantity => {
  const c = a.commodities.find((item) => item.id === id);
  if (!c) throw new RangeError('unknown commodity');
  return { kind: 'commodity', commodityId: id, unit: c.unit, scale: c.scale, quantity: value };
};
function account(a: AccountingState, id: string) {
  const found = a.accounts.find((item) => item.id === id);
  if (!found) throw new RangeError('unknown account');
  return found;
}
function apply(a: AccountingState, operation: AccountingOperation, key: string): AccountingState {
  return applyAccountingTransaction(a, [operation], key);
}
export function registerLogistics(engine: Engine, config: LogisticsConfig): void {
  const safe = structuredClone(config),
    digest = hash(safe),
    cityOwner = (cityId: string) => safe.cityOwnerIds?.[cityId] ?? cityId;
  if (
    !nonempty(safe.transitOwnerId) ||
    !Array.isArray(safe.cities) ||
    !Array.isArray(safe.routes) ||
    !safe.cities.length ||
    new Set(safe.cities).size !== safe.cities.length ||
    !safe.cities.every(nonempty)
  )
    throw new TypeError('invalid logistics cities/transit owner');
  if (safe.cities.includes(safe.transitOwnerId))
    throw new RangeError('transit owner must be distinct from cities');
  if (
    safe.cityOwnerIds &&
    Object.keys(safe.cityOwnerIds).some((city) => !safe.cities.includes(city))
  )
    throw new RangeError('unknown city owner mapping');
  if (safe.cityKingdomIds && safe.cities.some((city) => !nonempty(safe.cityKingdomIds?.[city])))
    throw new RangeError('every city requires an authoritative kingdom mapping');
  if (
    safe.cityKingdomIds &&
    Object.keys(safe.cityKingdomIds).some((city) => !safe.cities.includes(city))
  )
    throw new RangeError('unknown city kingdom mapping');
  for (const city of safe.cities)
    if (!safe.owners.includes(cityOwner(city))) throw new RangeError('invalid city owner mapping');
  const routeIds = new Set<string>();
  for (const route of safe.routes) {
    if (
      !nonempty(route.routeId) ||
      routeIds.has(route.routeId) ||
      !safe.cities.includes(route.sourceCityId) ||
      !safe.cities.includes(route.destinationCityId) ||
      route.sourceCityId === route.destinationCityId ||
      !positive(route.travelTicks) ||
      !positive(route.capacity) ||
      !positive(route.fare) ||
      !nonempty(route.carrierAccountId) ||
      (!safe.owners.includes(route.sourceCityId) && !safe.cityOwnerIds?.[route.sourceCityId]) ||
      (!safe.owners.includes(route.destinationCityId) &&
        !safe.cityOwnerIds?.[route.destinationCityId]) ||
      !safe.accounts.some((item) => item.id === route.carrierAccountId)
    )
      throw new RangeError('invalid logistics route');
    routeIds.add(route.routeId);
  }
  const init: LogisticsState = {
    version: 1,
    configDigest: digest,
    tick: 0,
    routes: safe.routes,
    ...(safe.cityKingdomIds ? { cityKingdomIds: safe.cityKingdomIds } : {}),
    shipments: [],
    closedRouteIds: [],
    blockedRouteIds: [],
    attackedRouteIds: [],
  };
  const ensure = (d: Record<string, unknown>): [LogisticsState, AccountingState] => {
    if (!d.accounting) d.accounting = createAccountingState(safe);
    if (!d.logistics) d.logistics = structuredClone(init);
    return [d.logistics as LogisticsState, d.accounting as AccountingState];
  };
  const rejectOnError = (f: () => void) => {
    try {
      f();
    } catch {
      throw new DomainCommandRejection();
    }
  };
  const requireRoute = (l: LogisticsState, id: unknown): LogisticsRoute => {
    const route = l.routes.find((item) => item.routeId === id);
    if (!route) throw new RangeError('unknown route');
    return route;
  };
  const effectiveCapacity = (
    d: Record<string, unknown>,
    route: LogisticsRoute,
    tick: number,
  ): number => {
    const government = d.government as
      | {
          kingdoms?: Array<{ kingdomId: string; treasuryAccountId: string }>;
          cityKingdomIds?: Record<string, string>;
          investments?: Array<{
            routeId?: string;
            governmentId: string;
            contractorAccountId: string;
            cost: number;
            capacityIncrease: number;
            effectiveTick: number;
            expiryTick: number;
            policyId: string;
          }>;
        }
      | undefined;
    const accounting = d.accounting as AccountingState | undefined;
    const bonus = (government?.investments ?? [])
      .filter((investment) => {
        if (
          investment.routeId !== route.routeId ||
          government?.cityKingdomIds?.[route.sourceCityId] !== investment.governmentId ||
          !positive(investment.capacityIncrease) ||
          investment.capacityIncrease > 1000 - route.capacity ||
          tick < investment.effectiveTick ||
          tick > investment.expiryTick
        )
          return false;
        const kingdom = government?.kingdoms?.find(
          (item) => item.kingdomId === investment.governmentId,
        );
        const journal = accounting?.journal.find(
          (entry) => entry.causeId === `government:${investment.policyId}:contract`,
        );
        const effect = journal?.effects[0] as
          { debit?: string; credit?: string; amount?: number } | undefined;
        return (
          !!kingdom &&
          journal?.type === 'payment' &&
          effect?.debit === kingdom.treasuryAccountId &&
          effect.credit === investment.contractorAccountId &&
          effect.amount === investment.cost &&
          investment.contractorAccountId === route.carrierAccountId
        );
      })
      .reduce((sum, investment) => sum + investment.capacityIncrease, 0);
    return route.capacity + bonus;
  };
  const transfer = (a: AccountingState, _from: string, to: string, s: Shipment, suffix: string) =>
    apply(
      a,
      {
        type: 'arrive',
        shipmentId: s.shipmentId,
        toOwnerId: to,
        causeId: `logistics:${s.shipmentId}:${suffix}`,
      },
      `logistics:${s.shipmentId}:${suffix}`,
    );
  engine.registerInvariant((d) => {
    const l = d.logistics as LogisticsState | undefined;
    if (!l) return;
    if (
      l.version !== 1 ||
      l.configDigest !== digest ||
      !Array.isArray(l.shipments) ||
      !Array.isArray(l.routes)
    )
      throw new TypeError('invalid logistics state');
    const a = d.accounting as AccountingState;
    if (!a || a.owners.indexOf(safe.transitOwnerId) < 0)
      throw new TypeError('missing logistics accounting');
    if (
      !Number.isSafeInteger(l.tick) ||
      l.tick < 0 ||
      hash(l.routes) !== hash(safe.routes) ||
      hash(l.cityKingdomIds ?? {}) !== hash(safe.cityKingdomIds ?? {})
    )
      throw new TypeError('invalid logistics tick/config routes');
    const ids = new Set<string>();
    const treatyCounts = new Map<string, number>();
    const capacity = new Map<string, number>();
    const expectedTransit = new Map<string, string>();
    for (const s of l.shipments) {
      if (!nonempty(s.shipmentId) || ids.has(s.shipmentId))
        throw new TypeError('duplicate/invalid shipment');
      ids.add(s.shipmentId);
      const route = requireRoute(l, s.routeId);
      const fareRoute = s.reroutedFromRouteId ? requireRoute(l, s.reroutedFromRouteId) : route;
      const rerouted = s.reroutedFromRouteId !== undefined;
      const rerouteRoute = rerouted ? requireRoute(l, s.reroutedFromRouteId) : undefined;
      const rerouteFareEntry = rerouted
        ? a.journal.find((entry) => entry.causeId === `logistics:${s.shipmentId}:reroute-fare`)
        : undefined;
      if (
        rerouted &&
        (!rerouteFareEntry ||
          rerouteFareEntry.type !== 'payment' ||
          (rerouteFareEntry.effects[0] as { debit?: string; credit?: string; amount?: number })
            .debit !== s.buyerAccountId ||
          (rerouteFareEntry.effects[0] as { debit?: string; credit?: string; amount?: number })
            .credit !== s.carrierAccountId ||
          (rerouteFareEntry.effects[0] as { debit?: string; credit?: string; amount?: number })
            .amount !== route.fare ||
          !positive(s.reroutedAtTick) ||
          (!positive(s.rerouteRemainingTicks) && s.rerouteRemainingTicks !== 0) ||
          s.departureTick !== s.reroutedAtTick ||
          route.sourceCityId !== rerouteRoute!.sourceCityId ||
          route.destinationCityId === rerouteRoute!.destinationCityId ||
          route.travelTicks >
            Number.MAX_SAFE_INTEGER - s.departureTick - s.rerouteRemainingTicks! ||
          s.arrivalTick < s.departureTick + s.rerouteRemainingTicks! + route.travelTicks)
      )
        throw new TypeError('invalid reroute provenance/timing');
      if (
        !rerouted &&
        (route.travelTicks > Number.MAX_SAFE_INTEGER - s.departureTick ||
          s.arrivalTick < s.departureTick + route.travelTicks)
      )
        throw new TypeError('shipment arrival precedes route travel time');
      const fareEntry = a.journal.find(
        (entry) => entry.causeId === `logistics:${s.shipmentId}:fare`,
      );
      if (
        !fareEntry ||
        fareEntry.type !== 'payment' ||
        (fareEntry.effects[0] as { debit?: string; credit?: string; amount?: number }).debit !==
          s.buyerAccountId ||
        (fareEntry.effects[0] as { debit?: string; credit?: string; amount?: number }).credit !==
          s.carrierAccountId ||
        (fareEntry.effects[0] as { debit?: string; credit?: string; amount?: number }).amount !==
          s.payment ||
        !positive(s.quantity) ||
        !a.commodities.some((c) => c.id === s.commodity) ||
        !positive(s.departureTick) ||
        !positive(s.arrivalTick) ||
        s.payment !== fareRoute.fare ||
        !nonempty(s.buyerAccountId) ||
        !nonempty(s.carrierAccountId) ||
        !a.accounts.some((item) => item.id === s.carrierAccountId) ||
        s.arrivalTick < s.departureTick
      )
        throw new TypeError('invalid shipment provenance/timing');
      if (!['in-transit', 'arrived', 'returning', 'returned'].includes(s.status))
        throw new TypeError('invalid shipment status');
      const originalFrom = l.cityKingdomIds?.[fareRoute.sourceCityId];
      const originalTo = l.cityKingdomIds?.[fareRoute.destinationCityId];
      if (d.diplomacy && originalFrom && originalTo && originalFrom !== originalTo) {
        const diplomacy = d.diplomacy as {
          offers: Array<{
            offerId: string;
            routeId: string;
            commodity: string;
            fromKingdomId: string;
            toKingdomId: string;
            effectiveTick?: number;
            expiryTick?: number;
            quota?: number;
          }>;
          withdrawals?: Array<{ offerId: string; effectiveTick: number }>;
        };
        const departure = s.rerouteOriginalDepartureTick ?? s.departureTick;
        const offer = diplomacy.offers.find((item) => item.offerId === s.treatyOfferId);
        if (
          !offer ||
          offer.routeId !== fareRoute.routeId ||
          offer.commodity !== s.commodity ||
          offer.fromKingdomId !== originalFrom ||
          offer.toKingdomId !== originalTo ||
          (offer.effectiveTick !== undefined && departure < offer.effectiveTick) ||
          (offer.expiryTick !== undefined && departure > offer.expiryTick) ||
          diplomacy.withdrawals?.some(
            (w) => w.offerId === offer.offerId && departure >= w.effectiveTick,
          )
        )
          throw new TypeError('invalid shipment treaty provenance');
        const count = (treatyCounts.get(offer.offerId) ?? 0) + 1;
        if (offer.quota !== undefined && count > offer.quota)
          throw new TypeError('shipment treaty quota exceeded');
        treatyCounts.set(offer.offerId, count);
      } else if (s.treatyOfferId !== undefined) {
        throw new TypeError('unexpected shipment treaty provenance');
      }
      if (s.status === 'in-transit' || s.status === 'returning') {
        const used = (capacity.get(route.routeId) ?? 0) + s.quantity;
        const historicalCapacity = Math.max(
          effectiveCapacity(d, route, s.departureTick),
          effectiveCapacity(d, route, l.tick + 1),
        );
        if (used > historicalCapacity) throw new TypeError('route capacity exceeded');
        capacity.set(route.routeId, used);
        expectedTransit.set(
          s.shipmentId,
          `${cityOwner(route.sourceCityId)}\u0000${s.commodity}\u0000${s.quantity}`,
        );
      }
    }
    const actualTransit = a.stock.filter((item) => item.location === 'transit');
    if (
      actualTransit.length !== expectedTransit.size ||
      actualTransit.some(
        (item) =>
          expectedTransit.get(item.shipmentId!) !==
          `${item.ownerId}\u0000${item.commodity}\u0000${item.quantity}`,
      )
    )
      throw new TypeError('transit stock does not match active shipments');
  });
  engine.registerPhaseSystem('infrastructure', 'logistics:initialize', (d) => {
    ensure(d);
  });
  engine.registerCommandHandler('logistics.depart', (d, payload) =>
    rejectOnError(() => {
      const [l, a] = ensure(d),
        p = payload as {
          shipmentId: unknown;
          routeId: unknown;
          commodity: unknown;
          quantity: unknown;
          buyerAccountId: unknown;
          payment: unknown;
        };
      const route = requireRoute(l, p?.routeId),
        now = l.tick + 1;
      const sourceKingdom = safe.cityKingdomIds?.[route.sourceCityId];
      const destinationKingdom = safe.cityKingdomIds?.[route.destinationCityId];
      if (d.diplomacy && (!sourceKingdom || !destinationKingdom))
        throw new RangeError('city kingdom mapping required when diplomacy is registered');
      const sanctions =
        (
          d.diplomacy as
            | {
                sanctions?: Array<{
                  issuerKingdomId: string;
                  targetKingdomId: string;
                  routeId: string;
                  commodity: string;
                  effectiveTick: number;
                  expiryTick: number;
                }>;
              }
            | undefined
        )?.sanctions ?? [];
      if (
        sanctions.some(
          (sanction) =>
            sanction.routeId === route.routeId &&
            sanction.commodity === p?.commodity &&
            sanction.effectiveTick <= now &&
            now <= sanction.expiryTick &&
            ((sanction.issuerKingdomId === sourceKingdom &&
              sanction.targetKingdomId === destinationKingdom) ||
              (sanction.issuerKingdomId === destinationKingdom &&
                sanction.targetKingdomId === sourceKingdom)),
        )
      )
        throw new RangeError('shipment blocked by active targeted sanction');
      if (
        sourceKingdom &&
        destinationKingdom &&
        sourceKingdom !== destinationKingdom &&
        !hasBilateralTradePermit(
          d,
          route.routeId,
          String(p?.commodity),
          sourceKingdom,
          destinationKingdom,
          now,
        )
      )
        throw new RangeError('bilateral trade permit is not accepted');
      if (
        !nonempty(p.shipmentId) ||
        !nonempty(p.buyerAccountId) ||
        !nonempty(p.commodity) ||
        !positive(p.quantity) ||
        p.payment !== route.fare ||
        l.shipments.some((s) => s.shipmentId === p.shipmentId) ||
        l.closedRouteIds.includes(route.routeId) ||
        l.blockedRouteIds.includes(route.routeId) ||
        l.attackedRouteIds.includes(route.routeId) ||
        route.travelTicks > Number.MAX_SAFE_INTEGER - now
      )
        throw new RangeError('invalid departure');
      const busy = l.shipments
        .filter(
          (s) =>
            s.routeId === route.routeId && (s.status === 'in-transit' || s.status === 'returning'),
        )
        .reduce((n, s) => n + s.quantity, 0);
      if (p.quantity > effectiveCapacity(d, route, now) - busy)
        throw new RangeError('route capacity exceeded');
      const buyer = account(a, p.buyerAccountId),
        carrier = account(a, route.carrierAccountId);
      if (buyer.id === carrier.id) throw new RangeError('invalid payment parties');
      const commodity = quantity(a, p.commodity, p.quantity),
        id = p.shipmentId;
      const government = d.government as
        | {
            kingdoms: Array<{ kingdomId: string; treasuryAccountId: string }>;
            tradePolicies?: Array<{
              variant: string;
              policyId: string;
              governmentId: string;
              importKingdomId: string;
              routeId: string;
              commodity: string;
              amount: number;
              effectiveTick: number;
              expiryTick: number;
            }>;
          }
        | undefined;
      const eligiblePolicy = (policy: {
        importKingdomId: string;
        routeId: string;
        commodity: string;
        effectiveTick: number;
        expiryTick: number;
      }) =>
        sourceKingdom !== undefined &&
        destinationKingdom !== undefined &&
        policy.importKingdomId === destinationKingdom &&
        policy.routeId === route.routeId &&
        policy.commodity === p.commodity &&
        now >= policy.effectiveTick &&
        now <= policy.expiryTick;
      const restricted = government?.tradePolicies?.some(
        (policy) => policy.variant === 'trade-restriction' && eligiblePolicy(policy),
      );
      if (restricted) throw new RangeError('shipment blocked by active import restriction');
      const tariffs =
        government?.tradePolicies?.filter(
          (policy) => policy.variant === 'import-tariff' && eligiblePolicy(policy),
        ) ?? [];
      const buyerIsMappedSource = buyer.ownerId === cityOwner(route.sourceCityId);
      if (tariffs.length && (!buyerIsMappedSource || sourceKingdom === destinationKingdom))
        throw new RangeError('tariff payer does not match trusted origin jurisdiction');
      const activeTreaty = (
        d.diplomacy as
          | {
              offers?: Array<{
                offerId: string;
                routeId: string;
                commodity: string;
                fromKingdomId: string;
                toKingdomId: string;
                effectiveTick?: number;
                expiryTick?: number;
                quota?: number;
                tariffDiscountBps?: number;
              }>;
              decisions?: Array<{ offerId: string; kingdomId: string; accepted: boolean }>;
              withdrawals?: Array<{ offerId: string; effectiveTick: number }>;
            }
          | undefined
      )?.offers?.find((offer) => {
        if (
          offer.routeId !== route.routeId ||
          offer.commodity !== p.commodity ||
          offer.fromKingdomId !== sourceKingdom ||
          offer.toKingdomId !== destinationKingdom ||
          (offer.effectiveTick !== undefined && now < offer.effectiveTick) ||
          (offer.expiryTick !== undefined && now > offer.expiryTick) ||
          (
            d.diplomacy as { withdrawals?: Array<{ offerId: string; effectiveTick: number }> }
          ).withdrawals?.some(
            (withdrawal) => withdrawal.offerId === offer.offerId && now >= withdrawal.effectiveTick,
          ) ||
          ![offer.fromKingdomId, offer.toKingdomId].every((kingdomId) =>
            (
              d.diplomacy as {
                decisions: Array<{ offerId: string; kingdomId: string; accepted: boolean }>;
              }
            ).decisions.some(
              (decision) =>
                decision.offerId === offer.offerId &&
                decision.kingdomId === kingdomId &&
                decision.accepted,
            ),
          )
        )
          return false;
        return (
          offer.quota === undefined ||
          l.shipments.filter((shipment) => shipment.treatyOfferId === offer.offerId).length <
            offer.quota
        );
      });
      if (
        d.diplomacy &&
        sourceKingdom &&
        destinationKingdom &&
        sourceKingdom !== destinationKingdom &&
        !activeTreaty
      )
        throw new RangeError('bilateral treaty departure quota exhausted');
      const discountBps = activeTreaty?.tariffDiscountBps ?? 0;
      const operations: AccountingOperation[] = [
        {
          type: 'payment',
          fromAccountId: buyer.id,
          toAccountId: carrier.id,
          amount: money(a, route.fare),
          causeId: `logistics:${id}:fare`,
        },
        ...tariffs.flatMap((policy) => {
          const importer = government!.kingdoms.find(
            (item) => item.kingdomId === policy.importKingdomId,
          );
          if (!importer) throw new RangeError('unknown tariff import treasury');
          const tariffAmount = Number(
            (BigInt(policy.amount) * BigInt(10_000 - discountBps)) / 10_000n,
          );
          return tariffAmount === 0
            ? []
            : [
                {
                  type: 'payment' as const,
                  fromAccountId: buyer.id,
                  toAccountId: account(a, importer.treasuryAccountId).id,
                  amount: money(a, tariffAmount),
                  causeId: `government:${policy.policyId}:shipment:${id}`,
                },
              ];
        }),
        {
          type: 'reserve',
          ownerId: cityOwner(route.sourceCityId),
          commodity: p.commodity,
          quantity: commodity,
          reservationId: `logistics:${id}:reservation`,
          causeId: `logistics:${id}:reserve`,
        },
        {
          type: 'depart',
          reservationId: `logistics:${id}:reservation`,
          shipmentId: id,
          causeId: `logistics:${id}:depart`,
        },
      ];
      const next = applyAccountingTransaction(a, operations, `logistics:${id}:depart`);
      d.accounting = next;
      l.shipments.push({
        shipmentId: id,
        routeId: route.routeId,
        commodity: p.commodity,
        quantity: p.quantity,
        departureTick: now,
        arrivalTick: now + route.travelTicks,
        status: 'in-transit',
        buyerAccountId: buyer.id,
        carrierAccountId: carrier.id,
        payment: route.fare,
        ...(activeTreaty ? { treatyOfferId: activeTreaty.offerId } : {}),
      });
    }),
  );
  engine.registerCommandHandler('logistics.route.close', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId);
      if (l.blockedRouteIds.includes(route.routeId) || l.attackedRouteIds.includes(route.routeId))
        throw new RangeError('route unavailable');
      if (!l.closedRouteIds.includes(route.routeId)) {
        const now = l.tick + 1;
        for (const s of l.shipments)
          if (s.routeId === route.routeId && s.status === 'in-transit')
            Object.assign(s, pauseRouteShipment(s, now));
        l.closedRouteIds.push(route.routeId);
      }
    }),
  );
  engine.registerCommandHandler('logistics.route.open', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId);
      if (l.closedRouteIds.includes(route.routeId)) {
        const now = l.tick + 1;
        for (const s of l.shipments)
          if (
            s.routeId === route.routeId &&
            s.status === 'in-transit' &&
            s.pausedRemainingTicks !== undefined
          ) {
            if (s.pausedRemainingTicks > Number.MAX_SAFE_INTEGER - now)
              throw new RangeError('arrival overflow');
            Object.assign(
              s,
              resumeRouteShipment(s as Shipment & { pausedRemainingTicks: number }, now),
            );
            delete s.pausedRemainingTicks;
          }
        l.closedRouteIds = l.closedRouteIds.filter((id) => id !== route.routeId);
      }
    }),
  );
  engine.registerCommandHandler('logistics.route.block', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId);
      if (l.closedRouteIds.includes(route.routeId) || l.attackedRouteIds.includes(route.routeId))
        throw new RangeError('route unavailable');
      if (!l.blockedRouteIds.includes(route.routeId)) {
        const now = l.tick + 1;
        for (const s of l.shipments)
          if (s.routeId === route.routeId && s.status === 'in-transit') {
            Object.assign(s, pauseRouteShipment(s, now));
            s.blockedAtTick = now;
          }
        l.blockedRouteIds.push(route.routeId);
      }
    }),
  );
  engine.registerCommandHandler('logistics.route.release-block', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId),
        now = l.tick + 1;
      for (const s of l.shipments)
        if (
          s.routeId === route.routeId &&
          s.status === 'in-transit' &&
          s.pausedRemainingTicks !== undefined
        ) {
          if (s.pausedRemainingTicks > Number.MAX_SAFE_INTEGER - now)
            throw new RangeError('arrival overflow');
          Object.assign(
            s,
            resumeRouteShipment(s as Shipment & { pausedRemainingTicks: number }, now),
          );
          delete s.pausedRemainingTicks;
          delete s.blockedAtTick;
        }
      l.blockedRouteIds = l.blockedRouteIds.filter((id) => id !== route.routeId);
    }),
  );
  engine.registerCommandHandler('logistics.route.attack', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId),
        now = l.tick + 1;
      if (l.closedRouteIds.includes(route.routeId) || l.blockedRouteIds.includes(route.routeId))
        throw new RangeError('route unavailable');
      if (l.attackedRouteIds.includes(route.routeId)) return;
      for (const s of l.shipments)
        if (s.routeId === route.routeId && s.status === 'in-transit') {
          const elapsed =
            s.reroutedFromRouteId === undefined
              ? activeOutwardElapsedTicks(
                  route.travelTicks,
                  route.travelTicks,
                  now - s.departureTick,
                )
              : activeOutwardElapsedTicks(
                  requireRoute(l, s.reroutedFromRouteId).travelTicks,
                  s.rerouteRemainingTicks!,
                  Math.max(0, now - s.reroutedAtTick!),
                );
          const due = returnDueTick(now, elapsed);
          if (due === undefined) throw new RangeError('return due tick overflow');
          if (elapsed === 0) {
            d.accounting = transfer(
              d.accounting as AccountingState,
              safe.transitOwnerId,
              cityOwner(route.sourceCityId),
              s,
              'attack-return',
            );
            s.status = 'returned';
            s.attackTick = now;
            s.returnDueTick = now;
          } else {
            s.status = 'returning';
            s.attackTick = now;
            s.returnDueTick = due;
            delete s.pausedRemainingTicks;
          }
        }
      l.attackedRouteIds.push(route.routeId);
    }),
  );
  engine.registerCommandHandler('logistics.route.clear-attack', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        route = requireRoute(l, (payload as { routeId?: unknown })?.routeId);
      l.attackedRouteIds = l.attackedRouteIds.filter((id) => id !== route.routeId);
    }),
  );
  engine.registerCommandHandler('logistics.shipment.wait', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        id = (payload as { shipmentId?: unknown })?.shipmentId;
      const s = l.shipments.find((item) => item.shipmentId === id);
      if (!s || s.status !== 'in-transit' || !l.blockedRouteIds.includes(s.routeId))
        throw new RangeError('shipment is not waiting at an obstruction');
    }),
  );
  engine.registerCommandHandler('logistics.shipment.return', (d, payload) =>
    rejectOnError(() => {
      const [l] = ensure(d),
        id = (payload as { shipmentId?: unknown })?.shipmentId,
        now = l.tick + 1;
      const s = l.shipments.find((item) => item.shipmentId === id);
      if (
        !s ||
        s.status !== 'in-transit' ||
        !l.blockedRouteIds.includes(s.routeId) ||
        s.reroutedFromRouteId
      )
        throw new RangeError('shipment is not return-eligible');
      const route = requireRoute(l, s.routeId),
        remaining = s.pausedRemainingTicks ?? s.arrivalTick - now,
        elapsed = Math.max(0, activeOutwardElapsedTicks(route.travelTicks, remaining, 0));
      const due = returnDueTick(now, elapsed);
      if (due === undefined) throw new RangeError('return due tick overflow');
      s.blockReturnTick = now;
      s.blockReturnElapsedTicks = elapsed;
      s.returnDueTick = due;
      delete s.pausedRemainingTicks;
      if (!elapsed) {
        d.accounting = transfer(
          d.accounting as AccountingState,
          safe.transitOwnerId,
          cityOwner(route.sourceCityId),
          s,
          'block-return',
        );
        s.status = 'returned';
      } else s.status = 'returning';
    }),
  );
  engine.registerCommandHandler('logistics.reroute', (d, payload) =>
    rejectOnError(() => {
      const [l, initial] = ensure(d),
        p = payload as { shipmentId?: unknown; routeId?: unknown; payment?: unknown },
        now = l.tick + 1;
      const s = l.shipments.find((item) => item.shipmentId === p?.shipmentId);
      if (
        !s ||
        s.status !== 'in-transit' ||
        !l.blockedRouteIds.includes(s.routeId) ||
        s.blockedAtTick === undefined
      )
        throw new RangeError('shipment is not obstructed');
      if (s.reroutedFromRouteId) throw new RangeError('second reroute is unsupported');
      if (!s.buyerAccountId || !s.carrierAccountId)
        throw new RangeError('unpaid shipments cannot be rerouted');
      const old = requireRoute(l, s.routeId),
        route = requireRoute(l, p?.routeId);
      if (
        !isPaidObstructionRerouteEligible({
          isInTransit: s.status === 'in-transit',
          isBlocked: l.blockedRouteIds.includes(s.routeId),
          hasBlockTick: s.blockedAtTick !== undefined,
          isPaid: !!s.buyerAccountId && !!s.carrierAccountId,
          alreadyRerouted: !!s.reroutedFromRouteId,
          sameOrigin: route.sourceCityId === old.sourceCityId,
          differentDestination: route.destinationCityId !== old.destinationCityId,
          alternateRouteOpen:
            !l.closedRouteIds.includes(route.routeId) &&
            !l.blockedRouteIds.includes(route.routeId) &&
            !l.attackedRouteIds.includes(route.routeId),
        })
      )
        throw new RangeError('invalid alternate route');
      if (p.payment !== route.fare) throw new RangeError('incorrect reroute fare');
      const remaining = s.pausedRemainingTicks!;
      if (
        !Number.isSafeInteger(remaining) ||
        remaining < 0 ||
        remaining > Number.MAX_SAFE_INTEGER - now ||
        route.travelTicks > Number.MAX_SAFE_INTEGER - now - remaining
      )
        throw new RangeError('reroute arrival overflow');
      const busy = l.shipments
        .filter(
          (item) =>
            item.routeId === route.routeId &&
            (item.status === 'in-transit' || item.status === 'returning'),
        )
        .reduce((n, item) => n + item.quantity, 0);
      if (s.quantity > effectiveCapacity(d, route, now) - busy)
        throw new RangeError('route capacity exceeded');
      const buyer = account(initial, s.buyerAccountId),
        carrier = account(initial, s.carrierAccountId);
      d.accounting = apply(
        initial,
        {
          type: 'payment',
          fromAccountId: buyer.id,
          toAccountId: carrier.id,
          amount: money(initial, route.fare),
          causeId: `logistics:${s.shipmentId}:reroute-fare`,
        },
        `logistics:${s.shipmentId}:reroute-fare`,
      );
      s.reroutedFromRouteId = s.routeId;
      s.reroutedAtTick = now;
      s.rerouteRemainingTicks = remaining;
      s.rerouteOriginalDepartureTick = s.departureTick;
      s.rerouteOriginalArrivalTick = s.arrivalTick;
      s.rerouteBlockedAtTick = s.blockedAtTick;
      s.routeId = route.routeId;
      s.departureTick = now;
      s.arrivalTick = now + remaining + route.travelTicks;
      delete s.pausedRemainingTicks;
      delete s.blockedAtTick;
    }),
  );
  engine.registerPhaseSystem('logistics', 'logistics:arrival', (d) => {
    const [l] = ensure(d),
      nextTick = l.tick + 1;
    for (const s of l.shipments) {
      if (
        s.status === 'in-transit' &&
        !l.closedRouteIds.includes(s.routeId) &&
        !l.blockedRouteIds.includes(s.routeId) &&
        s.arrivalTick <= nextTick
      ) {
        const route = requireRoute(l, s.routeId);
        d.accounting = transfer(
          d.accounting as AccountingState,
          safe.transitOwnerId,
          cityOwner(route.destinationCityId),
          s,
          'arrive',
        );
        s.status = 'arrived';
      } else if (s.status === 'returning' && s.returnDueTick! <= nextTick) {
        const route = requireRoute(l, s.routeId);
        d.accounting = transfer(
          d.accounting as AccountingState,
          safe.transitOwnerId,
          cityOwner(route.sourceCityId),
          s,
          'return',
        );
        s.status = 'returned';
      }
    }
    l.tick = nextTick;
  });
}
