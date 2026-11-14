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
  readonly status: 'in-transit' | 'arrived';
}

export interface RouteNetworkSnapshot {
  readonly tick: number;
  readonly routes: readonly RouteInput[];
  readonly shipments: readonly Shipment[];
}

export interface RouteNetwork {
  getState(): RouteNetworkSnapshot;
  depart(shipment: ShipmentInput): RouteNetworkSnapshot;
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
  let shipments: Shipment[] = [];
  let tick = 0;
  const snapshot = (): RouteNetworkSnapshot => ({
    tick,
    routes: [...routes.values()].map((route) => ({ ...route })),
    shipments: shipments.map((shipment) => ({ ...shipment })),
  });

  const prepareDeparture = (shipment: ShipmentInput): (() => void) => {
    validateId(shipment.shipmentId, 'shipment id');
    if (shipments.some(({ shipmentId }) => shipmentId === shipment.shipmentId)) {
      throw new RangeError(`duplicate shipment id: ${shipment.shipmentId}`);
    }
    const route = routes.get(shipment.routeId);
    if (!route) throw new RangeError(`unknown route: ${shipment.routeId}`);
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
        if (active.routeId === route.routeId && active.status === 'in-transit') {
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
      const due = shipments.filter(
        ({ status, arrivalTick }) => status === 'in-transit' && arrivalTick <= nextTick,
      );
      const balances = new Map<string, number>();
      for (const { ownerId, commodity, quantity } of input.inventory.getState().balances) {
        balances.set(`${ownerId}\0${commodity}`, quantity);
      }
      const deliveries = new Map<string, number>();
      const transitTotals = new Map<string, number>();
      for (const shipment of due) {
        const route = routes.get(shipment.routeId)!;
        const transitKey = `${transitOwnerId}\0${shipment.commodity}`;
        transitTotals.set(transitKey, (transitTotals.get(transitKey) ?? 0) + shipment.quantity);
        const destinationKey = `${route.destinationCityId}\0${shipment.commodity}`;
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
        toOwnerId: routes.get(shipment.routeId)!.destinationCityId,
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
        shipments[index] = { ...shipment, status: 'arrived' };
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
