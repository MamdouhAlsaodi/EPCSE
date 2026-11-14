import type { Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
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
  readonly attackTick?: number;
  readonly returnDueTick?: number;
}

export interface RouteNetworkSnapshot {
  readonly tick: number;
  readonly routes: readonly RouteInput[];
  readonly shipments: readonly Shipment[];
  /** Omitted in legacy snapshots; routes are then considered open. */
  readonly closedRouteIds?: readonly string[];
  readonly attackedRouteIds?: readonly string[];
}

export interface RouteNetwork {
  getState(): RouteNetworkSnapshot;
  depart(shipment: ShipmentInput): RouteNetworkSnapshot;
  /** Close immediately at the current tick; active journeys retain their remaining travel ticks. */
  closeRoute(routeId: string): RouteNetworkSnapshot;
  /** Reopen immediately at the current tick; paused journeys resume from then. */
  openRoute(routeId: string): RouteNetworkSnapshot;
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
  if (
    attackedRoutes.size !== attackedRouteIds.length ||
    [...attackedRoutes].some((id) => !routes.has(id))
  )
    throw new RangeError('invalid attacked route list');
  const closedRoutes = new Set(closedRouteIds);
  if (
    closedRoutes.size !== closedRouteIds.length ||
    [...closedRoutes].some((id) => !routes.has(id) || attackedRoutes.has(id))
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
            const elapsed = route.travelTicks - (shipment.arrivalTick - shipment.attackTick!);
            const expectedDue = shipment.attackTick! + elapsed;
            return (
              !Number.isSafeInteger(shipment.attackTick) ||
              shipment.attackTick! < shipment.departureTick ||
              shipment.attackTick! > tick ||
              !Number.isSafeInteger(elapsed) ||
              elapsed < 0 ||
              elapsed > route.travelTicks ||
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
            shipment.returnDueTick !== undefined ||
            attackedRoutes.has(shipment.routeId) ||
            (closedRoutes.has(shipment.routeId)
              ? !Number.isSafeInteger(shipment.pausedRemainingTicks) ||
                shipment.pausedRemainingTicks! <= 0 ||
                shipment.pausedRemainingTicks! > route.travelTicks ||
                shipment.arrivalTick - shipment.pausedRemainingTicks! < shipment.departureTick ||
                shipment.arrivalTick - shipment.pausedRemainingTicks! > tick
              : shipment.pausedRemainingTicks !== undefined || shipment.arrivalTick <= tick)
          : shipment.arrivalTick > tick ||
            shipment.pausedRemainingTicks !== undefined ||
            shipment.attackTick !== undefined ||
            shipment.returnDueTick !== undefined)
    )
      throw new RangeError('invalid initial shipment state');
  }
  const transitTotals = new Map<string, number>();
  for (const shipment of shipments)
    if (shipment.status === 'in-transit' || shipment.status === 'returning') {
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
  });

  const prepareDeparture = (shipment: ShipmentInput): (() => void) => {
    validateId(shipment.shipmentId, 'shipment id');
    if (shipments.some(({ shipmentId }) => shipmentId === shipment.shipmentId)) {
      throw new RangeError(`duplicate shipment id: ${shipment.shipmentId}`);
    }
    const route = routes.get(shipment.routeId);
    if (!route) throw new RangeError(`unknown route: ${shipment.routeId}`);
    if (closedRoutes.has(route.routeId)) throw new RangeError(`route is closed: ${route.routeId}`);
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
      { ...shipment, departureTick: tick, arrivalTick, status: 'in-transit' as const },
    ];
    return () => {
      shipments = stagedShipments;
    };
  };

  const api: RouteNetwork = {
    getState: snapshot,
    closeRoute: (routeId) => {
      if (!routes.has(routeId)) throw new RangeError(`unknown route: ${routeId}`);
      if (attackedRoutes.has(routeId)) throw new RangeError(`route is under attack: ${routeId}`);
      if (!closedRoutes.has(routeId)) {
        shipments = shipments.map((shipment) =>
          shipment.routeId === routeId && shipment.status === 'in-transit'
            ? { ...shipment, pausedRemainingTicks: shipment.arrivalTick - tick }
            : shipment,
        );
        closedRoutes.add(routeId);
      }
      return snapshot();
    },
    attackRoute: (routeId) => {
      const route = routes.get(routeId);
      if (!route) throw new RangeError(`unknown route: ${routeId}`);
      if (closedRoutes.has(routeId)) throw new RangeError(`route is closed: ${routeId}`);
      if (attackedRoutes.has(routeId)) return snapshot();
      const outbound = shipments.filter((s) => s.routeId === routeId && s.status === 'in-transit');
      for (const shipment of outbound) {
        const elapsed = route.travelTicks - (shipment.arrivalTick - tick);
        if (
          !Number.isSafeInteger(elapsed) ||
          elapsed < 0 ||
          elapsed > route.travelTicks ||
          elapsed > Number.MAX_SAFE_INTEGER - tick
        )
          throw new RangeError('return due tick would exceed Number.MAX_SAFE_INTEGER');
      }
      const immediate = outbound.filter((s) => route.travelTicks - (s.arrivalTick - tick) === 0);
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
        const elapsed = route.travelTicks - (s.arrivalTick - tick);
        const due = tick + elapsed;
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
          const { pausedRemainingTicks, ...active } = shipment;
          return { ...active, arrivalTick: tick + pausedRemainingTicks! };
        });
        closedRoutes.delete(routeId);
      }
      return snapshot();
    },
    depart: (shipment) => {
      const prepareNetwork = prepareDeparture(shipment);
      const route = routes.get(shipment.routeId)!;
      if (inventoryParticipant) {
        inventoryParticipant.prepareTransfer(
          route.sourceCityId,
          transitOwnerId,
          shipment.commodity,
          shipment.quantity,
        )();
      } else {
        input.inventory.transfer(
          route.sourceCityId,
          transitOwnerId,
          shipment.commodity,
          shipment.quantity,
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
  registerTransactionParticipant(api, {
    network: {
      inventory: input.inventory,
      transitOwnerId,
      getRouteSource: (routeId) => {
        const route = routes.get(routeId);
        if (!route) throw new RangeError(`unknown route: ${routeId}`);
        return route.sourceCityId;
      },
      prepareDeparture,
    },
  });
  return api;
}
