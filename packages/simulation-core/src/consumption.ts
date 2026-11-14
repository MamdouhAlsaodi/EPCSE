import type { CityMarket } from './city-market.js';
import { COMMODITIES, type Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
import type { MoneyLedger } from './money.js';
import type { PopulationCohortInput, PopulationNeed } from './population.js';
import type { World } from './world.js';
import { getTransactionParticipant } from './transaction-internal.js';

export interface ConsumptionSystemInput {
  readonly world: World;
  readonly cohort: PopulationCohortInput;
  readonly buyer: { readonly ownerId: string; readonly accountId: string };
  readonly sellers: Partial<Record<Commodity, string>>;
  readonly prices: Partial<Record<Commodity, number>>;
  readonly market: CityMarket;
  readonly inventory: Inventory;
  readonly money: MoneyLedger;
  readonly initialState?: {
    readonly unmetNeeds: readonly PopulationNeed[];
    readonly cumulativeUnmetNeeds: readonly PopulationNeed[];
  };
}

export interface ConsumptionSystem {
  getUnmetNeeds(): readonly PopulationNeed[];
  /** Sum of unmet quantities reported after each tick; this snapshot does not consume or retry them. */
  getCumulativeUnmetNeeds(): readonly PopulationNeed[];
}

export function createConsumptionSystem(input: ConsumptionSystemInput): ConsumptionSystem {
  if (!Array.isArray(input.cohort.needs)) throw new TypeError('cohort needs must be an array');
  const commodities = new Set<Commodity>();
  for (const need of input.cohort.needs) {
    if (!(COMMODITIES as readonly string[]).includes(need.commodity)) {
      throw new RangeError(`unknown commodity: ${need.commodity}`);
    }
    if (
      typeof need.quantity !== 'number' ||
      !Number.isFinite(need.quantity) ||
      !Number.isInteger(need.quantity)
    ) {
      throw new TypeError('need quantity must be a finite integer');
    }
    if (need.quantity <= 0 || !Number.isSafeInteger(need.quantity)) {
      throw new RangeError('need quantity must be a positive safe integer');
    }
    if (commodities.has(need.commodity)) {
      throw new RangeError(`duplicate need commodity: ${need.commodity}`);
    }
    commodities.add(need.commodity);
  }
  const initialState = input.initialState;
  if (initialState !== undefined) {
    if (
      !initialState ||
      typeof initialState !== 'object' ||
      !Array.isArray(initialState.unmetNeeds) ||
      !Array.isArray(initialState.cumulativeUnmetNeeds)
    )
      throw new RangeError('invalid initial consumption state');
    const configuredNeeds = new Map(
      input.cohort.needs.map((need) => [need.commodity, need.quantity]),
    );
    const validateNeeds = (needs: readonly PopulationNeed[], isUnmet: boolean): void => {
      const seen = new Set<Commodity>();
      for (const need of needs) {
        if (
          !need ||
          typeof need !== 'object' ||
          !COMMODITIES.includes(need.commodity) ||
          seen.has(need.commodity) ||
          !Number.isSafeInteger(need.quantity) ||
          need.quantity <= 0 ||
          !configuredNeeds.has(need.commodity) ||
          (isUnmet && need.quantity > configuredNeeds.get(need.commodity)!)
        )
          throw new RangeError('invalid initial consumption need');
        seen.add(need.commodity);
      }
    };
    validateNeeds(initialState.unmetNeeds, true);
    validateNeeds(initialState.cumulativeUnmetNeeds, false);
  }
  let unmetNeeds: PopulationNeed[] = (input.initialState?.unmetNeeds ?? input.cohort.needs).map(
    (need) => ({ ...need }),
  );
  let cumulativeUnmetNeeds: PopulationNeed[] = (input.initialState?.cumulativeUnmetNeeds ?? []).map(
    (need) => ({ ...need }),
  );
  input.world.registerTickSystem(`consumption:${input.cohort.cohortId}`, () => {
    const remaining: PopulationNeed[] = [];
    const trades: {
      readonly commodity: Commodity;
      readonly sellerId: string;
      readonly unitPrice: number;
      readonly quantity: number;
    }[] = [];
    let availableFunds =
      input.money.getState().balances.find((balance) => balance.accountId === input.buyer.accountId)
        ?.amount ?? 0;
    for (const need of input.cohort.needs) {
      const sellerId = input.sellers[need.commodity];
      const unitPrice = input.prices[need.commodity];
      if (
        !sellerId ||
        unitPrice === undefined ||
        !Number.isSafeInteger(unitPrice) ||
        unitPrice <= 0
      ) {
        remaining.push({ ...need });
        continue;
      }
      const stock =
        input.inventory
          .getState()
          .balances.find(
            (balance) => balance.ownerId === sellerId && balance.commodity === need.commodity,
          )?.quantity ?? 0;
      const quantity = Math.min(need.quantity, stock, Math.floor(availableFunds / unitPrice));
      if (quantity > 0) {
        trades.push({ commodity: need.commodity, sellerId, unitPrice, quantity });
        availableFunds -= quantity * unitPrice;
      }
      if (quantity < need.quantity) remaining.push({ ...need, quantity: need.quantity - quantity });
    }

    const cumulative = new Map(cumulativeUnmetNeeds.map((need) => [need.commodity, need.quantity]));
    for (const need of remaining) {
      const total = (cumulative.get(need.commodity) ?? 0) + need.quantity;
      if (!Number.isSafeInteger(total)) {
        throw new RangeError(`cumulative unmet need for ${need.commodity} exceeds safe integer`);
      }
      cumulative.set(need.commodity, total);
    }
    const nextCumulative = input.cohort.needs.flatMap((need) => {
      const quantity = cumulative.get(need.commodity);
      return quantity === undefined ? [] : [{ commodity: need.commodity, quantity }];
    });

    const atomicMarket = getTransactionParticipant(input.market)?.market;
    if (atomicMarket?.isCurrent()) {
      const commit = atomicMarket.prepareConsumption(
        trades.map((trade) => ({ buyerId: input.buyer.ownerId, ...trade })),
        input.buyer.ownerId,
        input.buyer.accountId,
        input.cohort.cityId,
        input.inventory,
        input.money,
      );
      commit();
    } else {
      // Custom markets retain their historical per-trade behavior; arbitrary external side effects
      // cannot be preflighted or rolled back by this consumption system.
      for (const trade of trades) {
        input.market.trade({
          cityId: input.cohort.cityId,
          buyerId: input.buyer.ownerId,
          sellerId: trade.sellerId,
          commodity: trade.commodity,
          quantity: trade.quantity,
          unitPrice: trade.unitPrice,
        });
        input.inventory.consume(input.buyer.ownerId, trade.commodity, trade.quantity);
      }
    }
    unmetNeeds = remaining;
    cumulativeUnmetNeeds = nextCumulative;
  });
  return {
    getUnmetNeeds: () => unmetNeeds.map((need) => ({ ...need })),
    getCumulativeUnmetNeeds: () => cumulativeUnmetNeeds.map((need) => ({ ...need })),
  };
}
