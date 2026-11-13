import { COMMODITIES, type Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
import type { MoneyLedger } from './money.js';

export interface CityMarketParticipant {
  readonly ownerId: string;
  readonly accountId: string;
}

export interface CityMarketInput {
  readonly cityId: string;
  readonly inventory: Inventory;
  readonly money: MoneyLedger;
  readonly participants: readonly CityMarketParticipant[];
}

export interface CityMarketTradeInput {
  readonly cityId: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly commodity: Commodity;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface CityMarketTradeReceipt extends CityMarketTradeInput {
  readonly total: number;
}

export interface CityMarket {
  trade(input: CityMarketTradeInput): CityMarketTradeReceipt;
}

export function createCityMarket(input: CityMarketInput): CityMarket {
  if (typeof input.cityId !== 'string' || input.cityId.length === 0) {
    throw new RangeError('city id must be nonempty');
  }
  const participants = new Map<string, string>();
  const accounts = new Set<string>();
  for (const participant of input.participants) {
    if (!participant.ownerId || !participant.accountId) {
      throw new RangeError('participant owner and account ids must be nonempty');
    }
    if (participants.has(participant.ownerId) || accounts.has(participant.accountId)) {
      throw new RangeError('duplicate market participant or account');
    }
    participants.set(participant.ownerId, participant.accountId);
    accounts.add(participant.accountId);
  }

  return {
    trade: (trade) => {
      if (trade.cityId !== input.cityId) throw new RangeError('trade city does not match market');
      if (!trade.buyerId || !trade.sellerId || trade.buyerId === trade.sellerId) {
        throw new RangeError('buyer and seller must be distinct participants');
      }
      if (!participants.has(trade.buyerId) || !participants.has(trade.sellerId)) {
        throw new RangeError('unknown market participant');
      }
      if (!(COMMODITIES as readonly string[]).includes(trade.commodity)) {
        throw new RangeError(`unknown commodity: ${trade.commodity}`);
      }
      for (const [name, value] of [
        ['quantity', trade.quantity],
        ['unit price', trade.unitPrice],
      ] as const) {
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new RangeError(`${name} must be a positive safe integer`);
        }
      }
      const totalBigInt = BigInt(trade.quantity) * BigInt(trade.unitPrice);
      if (totalBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('trade total exceeds Number.MAX_SAFE_INTEGER');
      }
      const total = Number(totalBigInt);
      const buyerAccount = participants.get(trade.buyerId)!;
      const sellerAccount = participants.get(trade.sellerId)!;
      const inventoryState = input.inventory.getState();
      const moneyState = input.money.getState();
      const stock =
        inventoryState.balances.find(
          (balance) => balance.ownerId === trade.sellerId && balance.commodity === trade.commodity,
        )?.quantity ?? 0;
      const buyerStock =
        inventoryState.balances.find(
          (balance) => balance.ownerId === trade.buyerId && balance.commodity === trade.commodity,
        )?.quantity ?? 0;
      const buyerFunds = moneyState.balances.find(
        (balance) => balance.accountId === buyerAccount,
      )?.amount;
      const sellerFunds = moneyState.balances.find(
        (balance) => balance.accountId === sellerAccount,
      )?.amount;
      if (buyerFunds === undefined || sellerFunds === undefined)
        throw new RangeError('unknown market account');
      if (buyerFunds < total) throw new RangeError('insufficient funds');
      if (stock < trade.quantity) throw new RangeError('insufficient inventory');
      if (trade.quantity > Number.MAX_SAFE_INTEGER - buyerStock)
        throw new RangeError('buyer inventory would exceed Number.MAX_SAFE_INTEGER');
      if (total > Number.MAX_SAFE_INTEGER - sellerFunds)
        throw new RangeError('seller balance would exceed Number.MAX_SAFE_INTEGER');

      // Every subsequent ledger operation is guaranteed to pass by the checks above.
      input.inventory.transfer(trade.sellerId, trade.buyerId, trade.commodity, trade.quantity);
      input.money.transfer(buyerAccount, sellerAccount, total);
      return { ...trade, total };
    },
  };
}
