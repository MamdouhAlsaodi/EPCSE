import type { Commodity } from './commodity.js';
import type { ShipmentInput } from './routes.js';

export interface InventoryTransactionParticipant {
  prepareTransfers(
    transfers: readonly {
      readonly fromOwnerId: string;
      readonly toOwnerId: string;
      readonly commodity: Commodity;
      readonly quantity: number;
    }[],
  ): () => void;
  prepareTransfer(
    fromOwnerId: string,
    toOwnerId: string,
    commodity: Commodity,
    quantity: number,
  ): () => void;
}

export interface MoneyTransactionParticipant {
  prepareTransfer(fromAccountId: string, toAccountId: string, amount: number): () => void;
}

export interface RouteTransactionParticipant {
  readonly inventory: object;
  readonly transitOwnerId: string;
  getRouteSource(routeId: string): string;
  prepareDeparture(shipment: ShipmentInput): () => void;
}

export interface TransactionParticipants {
  readonly inventory?: InventoryTransactionParticipant;
  readonly money?: MoneyTransactionParticipant;
  readonly network?: RouteTransactionParticipant;
}

const participants = new WeakMap<object, TransactionParticipants>();

export function registerTransactionParticipant(
  value: object,
  participant: TransactionParticipants,
): void {
  participants.set(value, participant);
}

export function getTransactionParticipant(value: object): TransactionParticipants | undefined {
  return participants.get(value);
}
