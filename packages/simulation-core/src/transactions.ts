import type { Inventory } from './inventory.js';
import type { MoneyLedger } from './money.js';
import type { RouteNetwork, ShipmentInput } from './routes.js';
import { getTransactionParticipant } from './transaction-internal.js';

export interface PaidShipmentInput {
  readonly shipment: ShipmentInput;
  readonly buyerAccountId: string;
  readonly sellerAccountId: string;
  /** Explicit integer settlement amount; no price is inferred by the coordinator. */
  readonly payment: number;
}

export interface PaidShipmentReceipt {
  readonly shipment: ShipmentInput;
  readonly payment: number;
}

export interface PaidShipmentCoordinatorInput {
  readonly inventory: Inventory;
  readonly money: MoneyLedger;
  readonly network: RouteNetwork;
}

export interface PaidShipmentCoordinator {
  depart(input: PaidShipmentInput): PaidShipmentReceipt;
}

export function createPaidShipmentCoordinator(
  input: PaidShipmentCoordinatorInput,
): PaidShipmentCoordinator {
  const inventory = input.inventory;
  const money = input.money;
  const network = input.network;
  const inventoryParticipant = getTransactionParticipant(inventory)?.inventory;
  const moneyParticipant = getTransactionParticipant(money)?.money;
  const routeParticipant = getTransactionParticipant(network)?.network;
  if (!inventoryParticipant || !moneyParticipant || !routeParticipant) {
    throw new TypeError('atomic shipment coordination requires built-in coordinator participants');
  }
  if (routeParticipant.inventory !== inventory) {
    throw new TypeError('route network and coordinator must use the same inventory instance');
  }

  return {
    // The public API is synchronous and only built-in participants are accepted. Snapshot
    // every caller-controlled property before preparation; from the first prepare through
    // commit, participant code invokes no caller code. Asynchronous side effects elsewhere
    // cannot be rolled back by this in-memory coordinator.
    depart: (paidShipment) => {
      const shipmentInput = paidShipment.shipment;
      const shipment = {
        shipmentId: shipmentInput.shipmentId,
        routeId: shipmentInput.routeId,
        commodity: shipmentInput.commodity,
        quantity: shipmentInput.quantity,
      };
      const buyerAccountId = paidShipment.buyerAccountId;
      const sellerAccountId = paidShipment.sellerAccountId;
      const payment = paidShipment.payment;

      if (buyerAccountId === sellerAccountId) {
        throw new RangeError('payer and carrier accounts must be distinct');
      }
      const sourceCityId = routeParticipant.getRouteSource(shipment.routeId);
      const prepareNetwork = routeParticipant.prepareDeparture(shipment);
      const prepareInventory = inventoryParticipant.prepareTransfer(
        sourceCityId,
        routeParticipant.transitOwnerId,
        shipment.commodity,
        shipment.quantity,
      );
      const prepareMoney = moneyParticipant.prepareTransfer(
        buyerAccountId,
        sellerAccountId,
        payment,
      );
      prepareInventory();
      prepareMoney();
      prepareNetwork();
      return { shipment, payment };
    },
  };
}
