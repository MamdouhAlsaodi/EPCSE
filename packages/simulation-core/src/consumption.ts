import type { CityMarket } from './city-market.js';
import type { Commodity } from './commodity.js';
import type { Inventory } from './inventory.js';
import type { MoneyLedger } from './money.js';
import type { PopulationCohortInput, PopulationNeed } from './population.js';
import type { World } from './world.js';

export interface ConsumptionSystemInput {
  readonly world: World;
  readonly cohort: PopulationCohortInput;
  readonly buyer: { readonly ownerId: string; readonly accountId: string };
  readonly sellers: Partial<Record<Commodity, string>>;
  readonly prices: Partial<Record<Commodity, number>>;
  readonly market: CityMarket;
  readonly inventory: Inventory;
  readonly money: MoneyLedger;
}

export interface ConsumptionSystem {
  getUnmetNeeds(): readonly PopulationNeed[];
}

export function createConsumptionSystem(input: ConsumptionSystemInput): ConsumptionSystem {
  let unmetNeeds: PopulationNeed[] = input.cohort.needs.map((need) => ({ ...need }));
  input.world.registerTickSystem(`consumption:${input.cohort.cohortId}`, () => {
    const remaining: PopulationNeed[] = [];
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
      const funds =
        input.money
          .getState()
          .balances.find((balance) => balance.accountId === input.buyer.accountId)?.amount ?? 0;
      const stock =
        input.inventory
          .getState()
          .balances.find(
            (balance) => balance.ownerId === sellerId && balance.commodity === need.commodity,
          )?.quantity ?? 0;
      const quantity = Math.min(need.quantity, stock, Math.floor(funds / unitPrice));
      if (quantity > 0) {
        input.market.trade({
          cityId: input.cohort.cityId,
          buyerId: input.buyer.ownerId,
          sellerId,
          commodity: need.commodity,
          quantity,
          unitPrice,
        });
        input.inventory.consume(input.buyer.ownerId, need.commodity, quantity);
      }
      if (quantity < need.quantity) remaining.push({ ...need, quantity: need.quantity - quantity });
    }
    unmetNeeds = remaining;
  });
  return { getUnmetNeeds: () => unmetNeeds.map((need) => ({ ...need })) };
}
