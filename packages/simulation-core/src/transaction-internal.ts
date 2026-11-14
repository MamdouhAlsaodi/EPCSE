import type { Commodity } from './commodity.js';
import type { ShipmentInput } from './routes.js';

export interface InventoryTransactionParticipant {
  isCurrent(): boolean;
  prepareTransfers(
    transfers: readonly {
      readonly fromOwnerId: string;
      readonly toOwnerId: string;
      readonly commodity: Commodity;
      readonly quantity: number;
    }[],
    consumes?: readonly {
      readonly ownerId: string;
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
  isCurrent(): boolean;
  prepareTransfer(fromAccountId: string, toAccountId: string, amount: number): () => void;
  prepareTransfers(
    transfers: readonly {
      readonly fromAccountId: string;
      readonly toAccountId: string;
      readonly amount: number;
    }[],
  ): () => void;
}

export interface MarketTransactionParticipant {
  isCurrent(): boolean;
  prepareConsumption(
    trades: readonly {
      readonly buyerId: string;
      readonly sellerId: string;
      readonly commodity: Commodity;
      readonly quantity: number;
      readonly unitPrice: number;
    }[],
    buyerId: string,
    buyerAccountId: string,
    cityId: string,
    inventory: object,
    money: object,
  ): () => void;
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
  readonly market?: MarketTransactionParticipant;
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
