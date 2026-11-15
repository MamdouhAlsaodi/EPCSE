import type { Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
import {
  activeOutwardElapsedTicks,
  isPaidObstructionRerouteEligible,
  pauseRouteShipment,
  returnDueTick,
  resumeRouteShipment,
} from './services/logistics/route-rules.js';
import {
  getTransactionParticipant,
  registerTransactionParticipant,
} from './transaction-internal.js';

export interface RouteInput {
  readonly routeId: string;
  readonly sourceCityId: string;
  readonly destinationCityId: string;
  readonly travelTicks: number;
  /**
   * Provisional capacity in shared abstract slots: each unit uses one slot regardless
   * of commodity. This is not a measure of physical weight or volume.
   */
  readonly capacity?: number;
}

export interface RouteNetworkInput {
  readonly cityIds: readonly string[];
  readonly transitOwnerId: string;
  readonly inventory: Inventory;
  readonly routes?: readonly RouteInput[];
  /**
   * Trusted in-memory checkpoint, not an authenticated payment record. The caller
   * must authorize its source before restoring; structural checks cannot prove
   * that a recorded paid departure occurred. Never accept this from an untrusted API client.
   */
  readonly initialState?: RouteNetworkSnapshot;
}

export interface ShipmentInput {
  readonly shipmentId: string;
  readonly routeId: string;
  readonly commodity: Commodity;
  readonly quantity: number;
}

export interface Shipment extends ShipmentInput {
  readonly departureTick: number;
  readonly arrivalTick: number;
  readonly status: 'in-transit' | 'arrived' | 'returning' | 'returned';
  /** Active travel ticks remaining while its route is closed. */
  readonly pausedRemainingTicks?: number;
  readonly blockedAtTick?: number;
  readonly attackTick?: number;
  /** Tick at which a non-attack obstruction return was selected. */
  readonly blockReturnTick?: number;
  readonly blockReturnElapsedTicks?: number;
  readonly returnDueTick?: number;
  readonly buyerAccountId?: string;
  readonly sellerAccountId?: string;
  readonly originalPayment?: number;
  readonly reroutedFromRouteId?: string;
  readonly reroutedAtTick?: number;
  readonly rerouteRemainingTicks?: number;
  readonly rerouteOriginalDepartureTick?: number;
  readonly rerouteOriginalArrivalTick?: number;
  readonly rerouteBlockedAtTick?: number;
}

export interface RouteNetworkSnapshot {
  readonly tick: number;
  readonly routes: readonly RouteInput[];
  readonly shipments: readonly Shipment[];
  /** Omitted in legacy snapshots; routes are then considered open. */
  readonly closedRouteIds?: readonly string[];
  readonly attackedRouteIds?: readonly string[];
  /** Omitted in legacy snapshots; routes are then considered unobstructed. */
  readonly blockedRouteIds?: readonly string[];
}

export interface RouteNetwork {
  getState(): RouteNetworkSnapshot;
  depart(shipment: ShipmentInput): RouteNetworkSnapshot;
  /** Close immediately at the current tick; active journeys retain their remaining travel ticks. */
  closeRoute(routeId: string): RouteNetworkSnapshot;
  /** Reopen immediately at the current tick; paused journeys resume from then. */
  openRoute(routeId: string): RouteNetworkSnapshot;
  /** Hold outbound journeys and prevent new departures until released or individually returned. */
  blockRoute(routeId: string): RouteNetworkSnapshot;
  releaseBlock(routeId: string): RouteNetworkSnapshot;
  /**
   * Returns one outbound shipment from a blocked route. Built-in Inventory preflights
   * zero-elapsed returns atomically; custom Inventory may partially transfer on failure.
   */
  returnBlockedShipment(shipmentId: string): RouteNetworkSnapshot;
  /**
   * Turns active outbound shipments homeward. Built-in Inventory batches immediate
   * zero-elapsed returns atomically; custom Inventory may partially transfer cargo
   * before a later transfer throws, without updating network state or rolling back.
   */
  attackRoute(routeId: string): RouteNetworkSnapshot;
  clearAttack(routeId: string): RouteNetworkSnapshot;
  /**
   * Moves from t to t+1 before delivering shipments due at t+1. Built-in Inventory
   * batches due deliveries atomically. Custom Inventory deliveries are transferred
   * sequentially and may leave earlier deliveries mutated if a later transfer throws;
   * the public Inventory API does not provide rollback.
   */
  advanceTick(): RouteNetworkSnapshot;
}

const validateId = (id: string, label: string): void => {
  if (typeof id !== 'string') throw new TypeError(`${label} must be a string`);
  if (id.length === 0) throw new RangeError(`${label} must be nonempty`);
};

export function createRouteNetwork(input: RouteNetworkInput): RouteNetwork {
  const cities = new Set<string>();
  for (const cityId of input.cityIds) {
    validateId(cityId, 'city id');
    if (cities.has(cityId)) throw new RangeError(`duplicate city id: ${cityId}`);
    cities.add(cityId);
  }
  const transitOwnerId = input.transitOwnerId;
  validateId(transitOwnerId, 'transit owner id');
  if (cities.has(transitOwnerId)) {
    throw new RangeError('transit inventory owner must be distinct from city owners');
  }
  for (const cityId of cities) {
    if (!input.inventory.hasOwner(cityId))
      throw new RangeError(`unknown inventory owner for city: ${cityId}`);
  }
  if (!input.inventory.hasOwner(transitOwnerId)) {
    throw new RangeError(`unknown transit inventory owner: ${transitOwnerId}`);
  }
  const inventoryParticipant = getTransactionParticipant(input.inventory)?.inventory;
  const routes = new Map<string, RouteInput>();
  for (const route of input.routes ?? []) {
    validateId(route.routeId, 'route id');
    if (routes.has(route.routeId)) throw new RangeError(`duplicate route id: ${route.routeId}`);
    validateId(route.sourceCityId, 'route source city id');
    validateId(route.destinationCityId, 'route destination city id');
    if (!cities.has(route.sourceCityId))
      throw new RangeError(`unknown source city: ${route.sourceCityId}`);
    if (!cities.has(route.destinationCityId))
      throw new RangeError(`unknown destination city: ${route.destinationCityId}`);
    if (route.sourceCityId === route.destinationCityId)
      throw new RangeError('route cities must be distinct');
    if (!Number.isSafeInteger(route.travelTicks) || route.travelTicks <= 0) {
      throw new RangeError('travel ticks must be a positive safe integer');
    }
    if (
      route.capacity !== undefined &&
      (!Number.isSafeInteger(route.capacity) || route.capacity <= 0)
    ) {
      throw new RangeError('route capacity must be a positive safe integer');
    }
    routes.set(route.routeId, { ...route });
  }
  const initialState = input.initialState;
  if (
    initialState &&
    (!Array.isArray(initialState.shipments) || !Array.isArray(initialState.routes))
  )
    throw new RangeError('invalid initial route state');
  let tick = initialState?.tick ?? 0;
  let shipments: Shipment[] = initialState?.shipments.map((shipment) => ({ ...shipment })) ?? [];
  if (initialState?.closedRouteIds !== undefined && !Array.isArray(initialState.closedRouteIds))
    throw new RangeError('invalid closed route list');
  const closedRouteIds = initialState?.closedRouteIds ?? [];
  if (initialState?.attackedRouteIds !== undefined && !Array.isArray(initialState.attackedRouteIds))
    throw new RangeError('invalid attacked route list');
  const attackedRouteIds = initialState?.attackedRouteIds ?? [];
  const attackedRoutes = new Set(attackedRouteIds);
  if (initialState?.blockedRouteIds !== undefined && !Array.isArray(initialState.blockedRouteIds))
    throw new RangeError('invalid blocked route list');
  const blockedRouteIds = initialState?.blockedRouteIds ?? [];
  const blockedRoutes = new Set(blockedRouteIds);
  if (
    blockedRoutes.size !== blockedRouteIds.length ||
    [...blockedRoutes].some((id) => !routes.has(id) || attackedRoutes.has(id))
  )
    throw new RangeError('invalid blocked route list');
  if (
    attackedRoutes.size !== attackedRouteIds.length ||
    [...attackedRoutes].some((id) => !routes.has(id))
  )
    throw new RangeError('invalid attacked route list');
  const closedRoutes = new Set(closedRouteIds);
  if (
    closedRoutes.size !== closedRouteIds.length ||
    [...closedRoutes].some(
      (id) => !routes.has(id) || attackedRoutes.has(id) || blockedRoutes.has(id),
    )
  )
    throw new RangeError('invalid closed route list');
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('invalid initial route tick');
  if (
    initialState &&
    (initialState.routes.length !== routes.size ||
      new Set(initialState.routes.map((route) => route.routeId)).size !== routes.size ||
      initialState.routes.some((route) => {
        const configured = routes.get(route.routeId);
        return (
          !configured ||
          route.sourceCityId !== configured.sourceCityId ||
          route.destinationCityId !== configured.destinationCityId ||
          route.travelTicks !== configured.travelTicks ||
          route.capacity !== configured.capacity
        );
      }))
  )
    throw new RangeError('initial routes do not match configured routes');
  const reroutedDurationLimit = (shipment: Shipment, alternative: RouteInput): number => {
    if (shipment.reroutedFromRouteId === undefined) return alternative.travelTicks;
    const original = routes.get(shipment.reroutedFromRouteId);
    if (!original) return 0;
    return original.travelTicks > Number.MAX_SAFE_INTEGER - alternative.travelTicks
      ? Number.MAX_SAFE_INTEGER
      : original.travelTicks + alternative.travelTicks;
  };
  const shipmentIds = new Set<string>();
  for (const shipment of shipments) {
    validateId(shipment.shipmentId, 'shipment id');
    if (shipmentIds.has(shipment.shipmentId))
      throw new RangeError(`duplicate shipment id: ${shipment.shipmentId}`);
    shipmentIds.add(shipment.shipmentId);
    if (!['grain', 'wood', 'tools'].includes(shipment.commodity))
      throw new RangeError('invalid initial shipment commodity');
    if (!['in-transit', 'arrived', 'returning', 'returned'].includes(shipment.status))
      throw new RangeError('invalid initial shipment status');
    const route = routes.get(shipment.routeId);
    if (
      !route ||
      !Number.isSafeInteger(shipment.quantity) ||
      shipment.quantity <= 0 ||
      !Number.isSafeInteger(shipment.departureTick) ||
      shipment.departureTick < 0 ||
      !Number.isSafeInteger(shipment.arrivalTick) ||
      shipment.arrivalTick <= shipment.departureTick ||
      shipment.arrivalTick < shipment.departureTick + route.travelTicks ||
      shipment.departureTick > tick ||
      (shipment.status === 'returning' || shipment.status === 'returned'
        ? (() => {
            const returnTick = shipment.attackTick ?? shipment.blockReturnTick;
            const elapsed =
              shipment.attackTick !== undefined
                ? shipment.reroutedFromRouteId === undefined
                  ? route.travelTicks - (shipment.arrivalTick - returnTick!)
                  : (routes.get(shipment.reroutedFromRouteId)?.travelTicks ?? Number.NaN) -
                    shipment.rerouteRemainingTicks! +
                    shipment.rerouteRemainingTicks! +
                    route.travelTicks -
                    (shipment.arrivalTick - returnTick!)
                : shipment.blockReturnElapsedTicks;
            const expectedDue = returnTick! + elapsed!;
            return (
              (shipment.attackTick === undefined) === (shipment.blockReturnTick === undefined) ||
              (shipment.attackTick !== undefined &&
                (shipment.blockReturnElapsedTicks !== undefined ||
                  shipment.blockedAtTick !== undefined)) ||
              (shipment.blockReturnTick !== undefined &&
                (!Number.isSafeInteger(shipment.blockReturnElapsedTicks) ||
                  !Number.isSafeInteger(shipment.blockedAtTick) ||
                  shipment.blockedAtTick! < shipment.departureTick ||
                  shipment.blockedAtTick! > shipment.blockReturnTick! ||
                  elapsed !==
                    route.travelTicks - (shipment.arrivalTick - shipment.blockedAtTick!))) ||
              !Number.isSafeInteger(returnTick) ||
              returnTick! < shipment.departureTick ||
              returnTick! > tick ||
              !Number.isSafeInteger(elapsed) ||
              elapsed! < 0 ||
              elapsed! > reroutedDurationLimit(shipment, route) ||
              (shipment.blockReturnTick !== undefined &&
                (elapsed! > Number.MAX_SAFE_INTEGER - returnTick! ||
                  elapsed! > shipment.blockReturnTick! - shipment.departureTick)) ||
              !Number.isSafeInteger(expectedDue) ||
              !Number.isSafeInteger(shipment.returnDueTick) ||
              shipment.returnDueTick !== expectedDue ||
              (shipment.status === 'returning'
                ? shipment.returnDueTick! <= tick
                : shipment.returnDueTick! > tick) ||
              shipment.pausedRemainingTicks !== undefined
            );
          })()
        : shipment.status === 'in-transit'
          ? shipment.attackTick !== undefined ||
            (shipment.blockedAtTick !== undefined && !blockedRoutes.has(shipment.routeId)) ||
            shipment.blockReturnTick !== undefined ||
            shipment.blockReturnElapsedTicks !== undefined ||
            shipment.returnDueTick !== undefined ||
            attackedRoutes.has(shipment.routeId) ||
            (closedRoutes.has(shipment.routeId) || blockedRoutes.has(shipment.routeId)
              ? !Number.isSafeInteger(shipment.pausedRemainingTicks) ||
                shipment.pausedRemainingTicks! <= 0 ||
                shipment.pausedRemainingTicks! >
                  (shipment.rerouteRemainingTicks ?? 0) + route.travelTicks ||
                shipment.arrivalTick - shipment.pausedRemainingTicks! < shipment.departureTick ||
                shipment.arrivalTick - shipment.pausedRemainingTicks! > tick ||
                (blockedRoutes.has(shipment.routeId)
                  ? !Number.isSafeInteger(shipment.blockedAtTick) ||
                    shipment.blockedAtTick !== shipment.arrivalTick - shipment.pausedRemainingTicks!
                  : shipment.blockedAtTick !== undefined)
              : shipment.pausedRemainingTicks !== undefined ||
                shipment.blockedAtTick !== undefined ||
                shipment.arrivalTick <= tick)
          : shipment.arrivalTick > tick ||
            shipment.pausedRemainingTicks !== undefined ||
            shipment.blockedAtTick !== undefined ||
            shipment.attackTick !== undefined ||
            shipment.blockReturnTick !== undefined ||
            shipment.blockReturnElapsedTicks !== undefined ||
            shipment.returnDueTick !== undefined)
    )
      throw new RangeError('invalid initial shipment state');
  }
  for (const shipment of shipments) {
    const paidFields = [
      shipment.buyerAccountId,
      shipment.sellerAccountId,
      shipment.originalPayment,
    ];
    const hasPaidProvenance = paidFields.some((value) => value !== undefined);
    const rerouteFields = [
      shipment.reroutedFromRouteId,
      shipment.reroutedAtTick,
      shipment.rerouteRemainingTicks,
      shipment.rerouteOriginalDepartureTick,
      shipment.rerouteOriginalArrivalTick,
      shipment.rerouteBlockedAtTick,
    ];
    const hasReroute = rerouteFields.some((value) => value !== undefined);
    if (
      (hasPaidProvenance &&
        (typeof shipment.buyerAccountId !== 'string' ||
          shipment.buyerAccountId.length === 0 ||
          typeof shipment.sellerAccountId !== 'string' ||
          shipment.sellerAccountId.length === 0 ||
          shipment.buyerAccountId === shipment.sellerAccountId ||
          !Number.isSafeInteger(shipment.originalPayment) ||
          shipment.originalPayment! <= 0)) ||
      (hasReroute &&
        (!hasPaidProvenance ||
          typeof shipment.reroutedFromRouteId !== 'string' ||
          !routes.has(shipment.reroutedFromRouteId) ||
          shipment.reroutedFromRouteId === shipment.routeId ||
          routes.get(shipment.reroutedFromRouteId)!.sourceCityId !==
            routes.get(shipment.routeId)!.sourceCityId ||
          routes.get(shipment.reroutedFromRouteId)!.destinationCityId ===
            routes.get(shipment.routeId)!.destinationCityId ||
          !Number.isSafeInteger(shipment.reroutedAtTick) ||
          shipment.reroutedAtTick! !== shipment.departureTick ||
          shipment.reroutedAtTick! > tick ||
          !Number.isSafeInteger(shipment.rerouteRemainingTicks) ||
          shipment.rerouteRemainingTicks! <= 0 ||
          !Number.isSafeInteger(shipment.rerouteOriginalDepartureTick) ||
          shipment.rerouteOriginalDepartureTick! < 0 ||
          !Number.isSafeInteger(shipment.rerouteOriginalArrivalTick) ||
          shipment.rerouteOriginalArrivalTick! <
            shipment.rerouteOriginalDepartureTick! +
              routes.get(shipment.reroutedFromRouteId)!.travelTicks ||
          !Number.isSafeInteger(shipment.rerouteBlockedAtTick) ||
          shipment.rerouteBlockedAtTick! < shipment.rerouteOriginalDepartureTick! ||
          shipment.rerouteBlockedAtTick! > shipment.reroutedAtTick! ||
          shipment.rerouteBlockedAtTick! > shipment.rerouteOriginalArrivalTick! ||
          shipment.rerouteRemainingTicks !==
            shipment.rerouteOriginalArrivalTick! - shipment.rerouteBlockedAtTick! ||
          shipment.rerouteRemainingTicks! > routes.get(shipment.reroutedFromRouteId)!.travelTicks ||
          shipment.reroutedAtTick! > Number.MAX_SAFE_INTEGER - shipment.rerouteRemainingTicks! ||
          shipment.reroutedAtTick! + shipment.rerouteRemainingTicks! >
            Number.MAX_SAFE_INTEGER - routes.get(shipment.routeId)!.travelTicks ||
          shipment.arrivalTick <
            shipment.reroutedAtTick! +
              shipment.rerouteRemainingTicks! +
              routes.get(shipment.routeId)!.travelTicks))
    )
      throw new RangeError('invalid shipment payment or reroute provenance');
  }
  const transitTotals = new Map<string, number>();
  const routeCapacityTotals = new Map<string, number>();
  for (const shipment of shipments)
    if (shipment.status === 'in-transit' || shipment.status === 'returning') {
      const routeTotal = (routeCapacityTotals.get(shipment.routeId) ?? 0) + shipment.quantity;
      const routeCapacity = routes.get(shipment.routeId)!.capacity;
      if (
        !Number.isSafeInteger(routeTotal) ||
        (routeCapacity !== undefined && routeTotal > routeCapacity)
      )
        throw new RangeError('invalid initial route capacity total');
      routeCapacityTotals.set(shipment.routeId, routeTotal);
      const key = shipment.commodity;
      const total = (transitTotals.get(key) ?? 0) + shipment.quantity;
      if (!Number.isSafeInteger(total)) throw new RangeError('invalid initial transit total');
      transitTotals.set(key, total);
    }
  for (const [commodity, quantity] of transitTotals) {
    const actual =
      input.inventory
        .getState()
        .balances.find(
          (balance) => balance.ownerId === transitOwnerId && balance.commodity === commodity,
        )?.quantity ?? 0;
    if (actual !== quantity)
      throw new RangeError('initial transit inventory does not match shipments');
  }
  for (const balance of input.inventory.getState().balances) {
    if (
      balance.ownerId === transitOwnerId &&
      (transitTotals.get(balance.commodity) ?? 0) !== balance.quantity
    )
      throw new RangeError('initial transit inventory does not match shipments');
  }
  const snapshot = (): RouteNetworkSnapshot => ({
    tick,
    routes: [...routes.values()].map((route) => ({ ...route })),
    shipments: shipments.map((shipment) => ({ ...shipment })),
    closedRouteIds: [...closedRoutes],
    attackedRouteIds: [...attackedRoutes],
    blockedRouteIds: [...blockedRoutes],
  });

  const prepareDeparture = (
    shipment: ShipmentInput,
    provenance?: {
      readonly buyerAccountId: string;
      readonly sellerAccountId: string;
      readonly originalPayment: number;
    },
  ): (() => void) => {
    validateId(shipment.shipmentId, 'shipment id');
    if (shipments.some(({ shipmentId }) => shipmentId === shipment.shipmentId)) {
      throw new RangeError(`duplicate shipment id: ${shipment.shipmentId}`);
    }
    const route = routes.get(shipment.routeId);
    if (!route) throw new RangeError(`unknown route: ${shipment.routeId}`);
    if (closedRoutes.has(route.routeId)) throw new RangeError(`route is closed: ${route.routeId}`);
    if (blockedRoutes.has(route.routeId))
      throw new RangeError(`route is blocked: ${route.routeId}`);
    if (attackedRoutes.has(route.routeId))
      throw new RangeError(`route is under attack: ${route.routeId}`);
    if (!Number.isSafeInteger(shipment.quantity) || shipment.quantity <= 0) {
      throw new RangeError('shipment quantity must be a positive safe integer');
    }
    if (route.travelTicks > Number.MAX_SAFE_INTEGER - tick) {
      throw new RangeError('arrival tick would exceed Number.MAX_SAFE_INTEGER');
    }
    const arrivalTick = tick + route.travelTicks;
    if (route.capacity !== undefined) {
      let inTransit = 0;
      for (const active of shipments) {
        if (
          active.routeId === route.routeId &&
          (active.status === 'in-transit' || active.status === 'returning')
        ) {
          if (active.quantity > route.capacity - inTransit) {
            throw new RangeError(`route capacity exceeded: ${route.routeId}`);
          }
          inTransit += active.quantity;
        }
      }
      if (shipment.quantity > route.capacity - inTransit) {
        throw new RangeError(`route capacity exceeded: ${route.routeId}`);
      }
    }
    const stagedShipments = [
      ...shipments,
      {
        shipmentId: shipment.shipmentId,
        routeId: shipment.routeId,
        commodity: shipment.commodity,
        quantity: shipment.quantity,
        ...(provenance ?? {}),
        departureTick: tick,
        arrivalTick,
        status: 'in-transit' as const,
      },
    ];
    return () => {
      shipments = stagedShipments;
    };
  };

  const prepareReroute = (shipmentId: string, routeId: string): (() => void) => {
    const shipment = shipments.find((candidate) => candidate.shipmentId === shipmentId);
    if (
      !shipment ||
      shipment.status !== 'in-transit' ||
      !blockedRoutes.has(shipment.routeId) ||
      shipment.blockedAtTick === undefined
    )
      throw new RangeError(`shipment is not eligible for reroute: ${shipmentId}`);
    if (shipment.buyerAccountId === undefined || shipment.sellerAccountId === undefined)
      throw new RangeError('unpaid shipments cannot be rerouted');
    if (shipment.reroutedFromRouteId !== undefined)
      throw new RangeError('shipment has already been rerouted');
    const originalRoute = routes.get(shipment.routeId)!;
    const alternative = routes.get(routeId);
    if (!alternative) throw new RangeError(`unknown route: ${routeId}`);
    if (closedRoutes.has(routeId) || blockedRoutes.has(routeId) || attackedRoutes.has(routeId))
      throw new RangeError(`alternative route is not open: ${routeId}`);
    if (
      !isPaidObstructionRerouteEligible({
        isInTransit: shipment.status === 'in-transit',
        isBlocked: blockedRoutes.has(shipment.routeId),
        hasBlockTick: shipment.blockedAtTick !== undefined,
        isPaid: shipment.buyerAccountId !== undefined && shipment.sellerAccountId !== undefined,
        alreadyRerouted: shipment.reroutedFromRouteId !== undefined,
        sameOrigin: alternative.sourceCityId === originalRoute.sourceCityId,
        differentDestination: alternative.destinationCityId !== originalRoute.destinationCityId,
        alternateRouteOpen:
          !closedRoutes.has(routeId) && !blockedRoutes.has(routeId) && !attackedRoutes.has(routeId),
      })
    )
      throw new RangeError('alternative route is not eligible for paid obstruction reroute');
    const remaining = shipment.pausedRemainingTicks!;
    if (
      !Number.isSafeInteger(remaining) ||
      remaining <= 0 ||
      remaining > Number.MAX_SAFE_INTEGER - tick ||
      alternative.travelTicks > Number.MAX_SAFE_INTEGER - tick - remaining
    )
      throw new RangeError('reroute arrival tick would exceed Number.MAX_SAFE_INTEGER');
    if (alternative.capacity !== undefined) {
      let active = 0;
      for (const other of shipments) {
        if (
          other.routeId === routeId &&
          (other.status === 'in-transit' || other.status === 'returning')
        ) {
          if (other.quantity > alternative.capacity - active)
            throw new RangeError(`route capacity exceeded: ${routeId}`);
          active += other.quantity;
        }
      }
      if (shipment.quantity > alternative.capacity - active)
        throw new RangeError(`route capacity exceeded: ${routeId}`);
    }
    const updated = {
      ...shipment,
      routeId,
      departureTick: tick,
      arrivalTick: tick + remaining + alternative.travelTicks,
      reroutedFromRouteId: shipment.routeId,
      reroutedAtTick: tick,
      rerouteRemainingTicks: remaining,
      rerouteOriginalDepartureTick: shipment.departureTick,
      rerouteOriginalArrivalTick: shipment.arrivalTick,
      rerouteBlockedAtTick: shipment.blockedAtTick,
    };
    delete (updated as { pausedRemainingTicks?: number }).pausedRemainingTicks;
    delete (updated as { blockedAtTick?: number }).blockedAtTick;
    const staged = shipments.map((candidate) =>
      candidate.shipmentId === shipmentId ? updated : candidate,
    );
    return () => {
      shipments = staged;
    };
  };

  const api: RouteNetwork = {
    getState: snapshot,
    closeRoute: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      if (attackedRoutes.has(routeId)) throw new RangeError(`route is under attack: ${routeId}`);
      if (blockedRoutes.has(routeId)) throw new RangeError(`route is blocked: ${routeId}`);
      if (!closedRoutes.has(routeId)) {
        shipments = shipments.map((shipment) =>
          shipment.routeId === routeId && shipment.status === 'in-transit'
            ? pauseRouteShipment(shipment, tick)
            : shipment,
        );
        closedRoutes.add(routeId);
      }
      return snapshot();
    },
    attackRoute: (routeId) => {
      const route = routes.get(routeId);
      if (!route) throw new RangeError(`unknown route: ${routeId}`);
      if (closedRoutes.has(routeId) || blockedRoutes.has(routeId))
        throw new RangeError(`route is closed or blocked: ${routeId}`);
      if (attackedRoutes.has(routeId)) return snapshot();
      const outbound = shipments.filter((s) => s.routeId === routeId && s.status === 'in-transit');
      const elapsedOutbound = (shipment: Shipment): number => {
        if (shipment.reroutedFromRouteId === undefined)
          return route.travelTicks - (shipment.arrivalTick - tick);
        const originalRoute = routes.get(shipment.reroutedFromRouteId)!;
        const selectedElapsed =
          shipment.rerouteRemainingTicks! + route.travelTicks - (shipment.arrivalTick - tick);
        return activeOutwardElapsedTicks(
          originalRoute.travelTicks,
          shipment.rerouteRemainingTicks!,
          selectedElapsed,
        );
      };
      for (const shipment of outbound) {
        const elapsed = elapsedOutbound(shipment);
        if (
          !Number.isSafeInteger(elapsed) ||
          elapsed < 0 ||
          elapsed > reroutedDurationLimit(shipment, route) ||
          elapsed > Number.MAX_SAFE_INTEGER - tick
        )
          throw new RangeError('return due tick would exceed Number.MAX_SAFE_INTEGER');
      }
      const immediate = outbound.filter((shipment) => elapsedOutbound(shipment) === 0);
      const balances = new Map(
        input.inventory
          .getState()
          .balances.map((b) => [`${b.ownerId}\\0${b.commodity}`, b.quantity]),
      );
      const grouped = new Map<string, number>();
      for (const s of immediate) {
        const key = `${route.sourceCityId}\\0${s.commodity}`;
        grouped.set(key, (grouped.get(key) ?? 0) + s.quantity);
      }
      for (const [key, quantity] of grouped)
        if (quantity > Number.MAX_SAFE_INTEGER - (balances.get(key) ?? 0))
          throw new RangeError('source inventory would exceed Number.MAX_SAFE_INTEGER');
      const transfers = immediate.map((s) => ({
        fromOwnerId: transitOwnerId,
        toOwnerId: route.sourceCityId,
        commodity: s.commodity,
        quantity: s.quantity,
      }));
      if (inventoryParticipant) inventoryParticipant.prepareTransfers(transfers)();
      else
        for (const transfer of transfers)
          input.inventory.transfer(
            transfer.fromOwnerId,
            transfer.toOwnerId,
            transfer.commodity,
            transfer.quantity,
          );
      shipments = shipments.map((s) => {
        if (!outbound.includes(s)) return s;
        const elapsed = elapsedOutbound(s);
        const due = returnDueTick(tick, elapsed);
        if (due === undefined)
          throw new RangeError('return due tick would exceed Number.MAX_SAFE_INTEGER');
        return elapsed === 0
          ? { ...s, status: 'returned', attackTick: tick, returnDueTick: due }
          : { ...s, status: 'returning', attackTick: tick, returnDueTick: due };
      });
      attackedRoutes.add(routeId);
      return snapshot();
    },
    clearAttack: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      attackedRoutes.delete(routeId);
      return snapshot();
    },
    blockRoute: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      if (closedRoutes.has(routeId) || attackedRoutes.has(routeId))
        throw new RangeError(`route is closed or under attack: ${routeId}`);
      if (!blockedRoutes.has(routeId)) {
        shipments = shipments.map((shipment) =>
          shipment.routeId === routeId && shipment.status === 'in-transit'
            ? { ...pauseRouteShipment(shipment, tick), blockedAtTick: tick }
            : shipment,
        );
        blockedRoutes.add(routeId);
      }
      return snapshot();
    },
    releaseBlock: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      if (blockedRoutes.has(routeId)) {
        for (const shipment of shipments) {
          if (
            shipment.routeId === routeId &&
            shipment.status === 'in-transit' &&
            shipment.pausedRemainingTicks! > Number.MAX_SAFE_INTEGER - tick
          )
            throw new RangeError('arrival tick would exceed Number.MAX_SAFE_INTEGER');
        }
        shipments = shipments.map((shipment) => {
          if (shipment.routeId !== routeId || shipment.status !== 'in-transit') return shipment;
          const paused = { ...shipment };
          delete paused.blockedAtTick;
          return resumeRouteShipment(
            paused as typeof shipment & { pausedRemainingTicks: number },
            tick,
          );
        });
        blockedRoutes.delete(routeId);
      }
      return snapshot();
    },
    returnBlockedShipment: (shipmentId) => {
      const shipment = shipments.find(({ shipmentId: id }) => id === shipmentId);
      if (
        !shipment ||
        shipment.status !== 'in-transit' ||
        !blockedRoutes.has(shipment.routeId) ||
        shipment.reroutedFromRouteId !== undefined
      )
        throw new RangeError(
          `shipment is not eligible for return from a blocked route: ${shipmentId}`,
        );
      const route = routes.get(shipment.routeId)!;
      const remaining = shipment.pausedRemainingTicks!;
      const elapsed = activeOutwardElapsedTicks(route.travelTicks, remaining, 0);
      if (
        !Number.isSafeInteger(elapsed) ||
        elapsed < 0 ||
        elapsed > route.travelTicks ||
        elapsed > Number.MAX_SAFE_INTEGER - tick
      )
        throw new RangeError('return due tick would exceed Number.MAX_SAFE_INTEGER');
      const due = tick + elapsed;
      const immediateReturn = elapsed === 0;
      if (immediateReturn) {
        const balances = new Map(
          input.inventory
            .getState()
            .balances.map((b) => [`${b.ownerId}\\0${b.commodity}`, b.quantity]),
        );
        const key = `${route.sourceCityId}\\0${shipment.commodity}`;
        if (shipment.quantity > Number.MAX_SAFE_INTEGER - (balances.get(key) ?? 0))
          throw new RangeError('source inventory would exceed Number.MAX_SAFE_INTEGER');
        const transfer = {
          fromOwnerId: transitOwnerId,
          toOwnerId: route.sourceCityId,
          commodity: shipment.commodity,
          quantity: shipment.quantity,
        };
        if (inventoryParticipant) inventoryParticipant.prepareTransfers([transfer])();
        else
          input.inventory.transfer(
            transfer.fromOwnerId,
            transfer.toOwnerId,
            transfer.commodity,
            transfer.quantity,
          );
      }
      shipments = shipments.map((active) => {
        if (active.shipmentId !== shipmentId) return active;
        const unpaused = { ...active };
        delete unpaused.pausedRemainingTicks;
        return {
          ...unpaused,
          status: immediateReturn ? 'returned' : 'returning',
          blockReturnTick: tick,
          blockReturnElapsedTicks: elapsed,
          returnDueTick: due,
        };
      });
      return snapshot();
    },
    openRoute: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      if (closedRoutes.has(routeId)) {
        for (const shipment of shipments) {
          if (
            shipment.routeId === routeId &&
            shipment.status === 'in-transit' &&
            shipment.pausedRemainingTicks! > Number.MAX_SAFE_INTEGER - tick
          )
            throw new RangeError('arrival tick would exceed Number.MAX_SAFE_INTEGER');
        }
        shipments = shipments.map((shipment) => {
          if (shipment.routeId !== routeId || shipment.status !== 'in-transit') return shipment;
          return resumeRouteShipment(
            shipment as typeof shipment & { pausedRemainingTicks: number },
            tick,
          );
        });
        closedRoutes.delete(routeId);
      }
      return snapshot();
    },
    depart: (shipment) => {
      const trustedInput: ShipmentInput = {
        shipmentId: shipment.shipmentId,
        routeId: shipment.routeId,
        commodity: shipment.commodity,
        quantity: shipment.quantity,
      };
      const prepareNetwork = prepareDeparture(trustedInput);
      const route = routes.get(trustedInput.routeId)!;
      if (inventoryParticipant) {
        inventoryParticipant.prepareTransfer(
          route.sourceCityId,
          transitOwnerId,
          trustedInput.commodity,
          trustedInput.quantity,
        )();
      } else {
        input.inventory.transfer(
          route.sourceCityId,
          transitOwnerId,
          trustedInput.commodity,
          trustedInput.quantity,
        );
      }
      prepareNetwork();
      return snapshot();
    },
    advanceTick: () => {
      if (tick === Number.MAX_SAFE_INTEGER)
        throw new RangeError('tick would exceed Number.MAX_SAFE_INTEGER');
      const nextTick = tick + 1;
      const due = shipments.filter(({ status, arrivalTick, routeId, returnDueTick }) =>
        status === 'returning'
          ? returnDueTick! <= nextTick
          : status === 'in-transit' &&
            !closedRoutes.has(routeId) &&
            !blockedRoutes.has(routeId) &&
            !attackedRoutes.has(routeId) &&
            arrivalTick <= nextTick,
      );
      const balances = new Map<string, number>();
      for (const { ownerId, commodity, quantity } of input.inventory.getState().balances) {
        balances.set(`${ownerId}\0${commodity}`, quantity);
      }
      const deliveries = new Map<string, number>();
      const transitTotals = new Map<string, number>();
      for (const shipment of due) {
        const route = routes.get(shipment.routeId)!;
        const destinationId =
          shipment.status === 'returning' ? route.sourceCityId : route.destinationCityId;
        const transitKey = `${transitOwnerId}\0${shipment.commodity}`;
        transitTotals.set(transitKey, (transitTotals.get(transitKey) ?? 0) + shipment.quantity);
        const destinationKey = `${destinationId}\0${shipment.commodity}`;
        deliveries.set(destinationKey, (deliveries.get(destinationKey) ?? 0) + shipment.quantity);
      }
      for (const [key, quantity] of transitTotals) {
        if ((balances.get(key) ?? 0) < quantity)
          throw new RangeError('insufficient transit inventory');
      }
      for (const [key, quantity] of deliveries) {
        if (quantity > Number.MAX_SAFE_INTEGER - (balances.get(key) ?? 0)) {
          throw new RangeError('destination inventory would exceed Number.MAX_SAFE_INTEGER');
        }
      }
      const transfers = due.map((shipment) => ({
        fromOwnerId: transitOwnerId,
        toOwnerId:
          shipment.status === 'returning'
            ? routes.get(shipment.routeId)!.sourceCityId
            : routes.get(shipment.routeId)!.destinationCityId,
        commodity: shipment.commodity,
        quantity: shipment.quantity,
      }));
      if (inventoryParticipant) {
        // The built-in inventory stages the complete batch before committing it.
        inventoryParticipant.prepareTransfers(transfers)();
      } else {
        // Custom inventories have no batch/rollback contract: each transfer may mutate,
        // and a later throw can leave earlier deliveries applied.
        for (const transfer of transfers) {
          input.inventory.transfer(
            transfer.fromOwnerId,
            transfer.toOwnerId,
            transfer.commodity,
            transfer.quantity,
          );
        }
      }
      for (const shipment of due) {
        const index = shipments.findIndex(({ shipmentId }) => shipmentId === shipment.shipmentId);
        shipments[index] = {
          ...shipment,
          status: shipment.status === 'returning' ? 'returned' : 'arrived',
        };
      }
      tick = nextTick;
      return snapshot();
    },
  };
  const originalDepart = api.depart;
  registerTransactionParticipant(api, {
    network: {
      isCurrent: () => api.depart === originalDepart,
      inventory: input.inventory,
      transitOwnerId,
      getRouteSource: (routeId) => {
        const route = routes.get(routeId);
        if (!route) throw new RangeError(`unknown route: ${routeId}`);
        return route.sourceCityId;
      },
      getPaidAccounts: (shipmentId) => {
        const shipment = shipments.find((candidate) => candidate.shipmentId === shipmentId);
        if (!shipment?.buyerAccountId || !shipment.sellerAccountId)
          throw new RangeError(`shipment has no paid provenance: ${shipmentId}`);
        return {
          buyerAccountId: shipment.buyerAccountId,
          sellerAccountId: shipment.sellerAccountId,
        };
      },
      prepareDeparture,
      prepareReroute,
    },
  });
  return api;
}
