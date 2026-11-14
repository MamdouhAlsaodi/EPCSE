import type { CityMarket } from './city-market.js';
import type { Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
import type { MoneyLedger } from './money.js';
import { calculateProvisionalPrice } from './pricing.js';
import type { World } from './world.js';

export interface MarketClearingOutcome {
  readonly tick: number;
  readonly price: number;
  readonly quantity: number;
  readonly unmetDemand: number;
}

export interface RegisterMarketClearingInput {
  readonly world: World;
  readonly cityId: string;
  readonly commodity: Commodity;
  readonly buyerId: string;
  readonly buyerAccountId: string;
  readonly sellerId: string;
  /** Fixed desired units for every tick. */
  readonly desiredDemand: number;
  readonly basePrice: number;
  readonly maxPrice: number;
  readonly market: CityMarket;
  readonly inventory: Inventory;
  readonly money: MoneyLedger;
  readonly onTick: (outcome: MarketClearingOutcome) => void;
}

/**
 * Register recurring clearing with provisional pricing. Each tick's price uses
 * fixed desired demand and the seller's currently available stock as supply;
 * these are current-tick observations, not historical market statistics.
 */
export function registerMarketClearing(input: RegisterMarketClearingInput): void {
  if (!Number.isSafeInteger(input.desiredDemand) || input.desiredDemand < 0) {
    throw new RangeError('desiredDemand must be a nonnegative safe integer');
  }
  input.world.registerTickSystem(
    `market-clearing:${input.cityId}:${input.commodity}:${input.buyerId}:${input.sellerId}`,
    ({ tick }) => {
      const balances = input.inventory.getState().balances;
      const sellerStock =
        balances.find(
          (balance) => balance.ownerId === input.sellerId && balance.commodity === input.commodity,
        )?.quantity ?? 0;
      const buyerStock =
        balances.find(
          (balance) => balance.ownerId === input.buyerId && balance.commodity === input.commodity,
        )?.quantity ?? 0;
      const supply = sellerStock;
      const price = calculateProvisionalPrice({
        basePrice: input.basePrice,
        demand: input.desiredDemand,
        supply,
        maxPrice: input.maxPrice,
      });
      const buyerFunds = input.money
        .getState()
        .balances.find((balance) => balance.accountId === input.buyerAccountId)?.amount;
      if (buyerFunds === undefined) throw new RangeError('unknown buyer account');
      const affordableQuantity = Math.floor(buyerFunds / price);
      const quantity = Math.min(
        input.desiredDemand,
        sellerStock,
        Number.MAX_SAFE_INTEGER - buyerStock,
        affordableQuantity,
      );
      if (quantity > 0) {
        input.market.trade({
          cityId: input.cityId,
          buyerId: input.buyerId,
          sellerId: input.sellerId,
          commodity: input.commodity,
          quantity,
          unitPrice: price,
        });
      }
      input.onTick({ tick, price, quantity, unmetDemand: input.desiredDemand - quantity });
    },
  );
}
