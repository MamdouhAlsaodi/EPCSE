import type { Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';

export interface RouteInput {
  readonly routeId: string;
  readonly sourceCityId: string;
  readonly destinationCityId: string;
  readonly travelTicks: number;
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
  /** Moves from t to t+1 before delivering shipments due at t+1. */
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
    routes.set(route.routeId, { ...route });
  }
  const shipments: Shipment[] = [];
  let tick = 0;
  const snapshot = (): RouteNetworkSnapshot => ({
    tick,
    routes: [...routes.values()].map((route) => ({ ...route })),
    shipments: shipments.map((shipment) => ({ ...shipment })),
  });

  return {
    getState: snapshot,
    depart: (shipment) => {
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
      input.inventory.transfer(
        route.sourceCityId,
        transitOwnerId,
        shipment.commodity,
        shipment.quantity,
      );
      shipments.push({
        ...shipment,
        departureTick: tick,
        arrivalTick: tick + route.travelTicks,
        status: 'in-transit',
      });
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
      for (const shipment of due) {
        const route = routes.get(shipment.routeId)!;
        input.inventory.transfer(
          transitOwnerId,
          route.destinationCityId,
          shipment.commodity,
          shipment.quantity,
        );
      }
      for (const shipment of due) {
        const index = shipments.findIndex(({ shipmentId }) => shipmentId === shipment.shipmentId);
        shipments[index] = { ...shipment, status: 'arrived' };
      }
      tick = nextTick;
      return snapshot();
    },
  };
}
