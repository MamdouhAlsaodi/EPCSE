import {
  createEngine,
  registerLocalEconomy,
  registerLogistics,
  applyAccountingTransaction,
  type AccountingState,
  type LocalEconomyConfig,
} from '@epcse/simulation-core';

const cities = ['grain-coast', 'tool-inland'] as const;
const goods = ['grain', 'wood', 'tools'] as const;

export interface InitialTwoCitiesReport {
  ticks: number;
  cities: readonly string[];
  goods: readonly string[];
  production: { grain: number; wood: number; tools: number };
  trade: {
    departed: number;
    arrived: number;
    firstDepartureTick: number;
    firstArrivalTick: number;
    woodQuantity: number;
    unitPrice: number;
    paidTotal: number;
    paymentCount: number;
    arrivalsPaidAfterDelivery: boolean;
    paymentPartiesValid: boolean;
  };
  payments: { trade: number; wages: number; localPurchases: number; freight: number };
  paymentJournalEntries: number;
  effects: string[];
  causes: string[];
  prices: number[];
  stock: {
    nonnegative: boolean;
    final: Array<{ ownerId: string; commodity: string; quantity: number }>;
  };
  money: { nonnegative: boolean; total: number; openingTotal: number };
  shipments: Array<{
    status: string;
    inTransitImmediatelyBeforeArrival: boolean;
    destinationEmptyImmediatelyBeforeArrival: boolean;
    deliveredWood: number;
    paidWood: number;
  }>;
  hashes: { state: string; events: string };
  unmetNeeds: Record<string, number>;
}

export function runInitialTwoCities(seed = 42, ticks = 100): { report(): InitialTwoCitiesReport } {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('seed must be uint32');
  if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new RangeError('ticks must be positive');
  const ledger = {
    currency: { id: 'coin', unit: 'coin', scale: 0 },
    commodities: goods.map((id) => ({ id, unit: 'unit', scale: 0 })),
    owners: [
      'grain-farm',
      'woodlot',
      'toolworks',
      'grain-coast',
      'tool-inland',
      'households-coast',
      'households-inland',
      'carrier',
      'transit',
    ],
    accounts: [
      { id: 'grain-farm-cash', ownerId: 'grain-farm', openingBalance: 1000 },
      { id: 'woodlot-cash', ownerId: 'woodlot', openingBalance: 1000 },
      { id: 'toolworks-cash', ownerId: 'toolworks', openingBalance: 1000 },
      { id: 'coast-households-cash', ownerId: 'households-coast', openingBalance: 30000 },
      { id: 'inland-households-cash', ownerId: 'households-inland', openingBalance: 3000 },
      { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
    ],
    stock: [
      { ownerId: 'woodlot', commodity: 'wood', quantity: 100 },
      { ownerId: 'grain-farm', commodity: 'grain', quantity: 10 },
      { ownerId: 'grain-farm', commodity: 'wood', quantity: 100 },
      { ownerId: 'woodlot', commodity: 'grain', quantity: 100 },
    ],
    recipes: [
      {
        id: 'grain-growing',
        inputs: [{ commodity: 'wood', quantity: 1 }],
        outputs: [{ commodity: 'grain', quantity: 2 }],
      },
      {
        id: 'wood-cutting',
        inputs: [{ commodity: 'grain', quantity: 1 }],
        outputs: [{ commodity: 'wood', quantity: 2 }],
      },
      {
        id: 'toolmaking',
        inputs: [{ commodity: 'wood', quantity: 1 }],
        outputs: [{ commodity: 'tools', quantity: 1 }],
      },
    ],
  };
  const engine = createEngine({ worldId: 'initial-two-cities' }, seed);
  const economy: LocalEconomyConfig = {
    ...ledger,
    producers: [
      {
        id: 'coast-grain-farm',
        cityId: cities[0],
        ownerId: 'grain-farm',
        accountId: 'grain-farm-cash',
        recipeId: 'grain-growing',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 2,
      },
      {
        id: 'coast-woodlot',
        cityId: cities[0],
        ownerId: 'woodlot',
        accountId: 'woodlot-cash',
        recipeId: 'wood-cutting',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 2,
      },
      {
        id: 'inland-toolworks',
        cityId: cities[1],
        ownerId: 'toolworks',
        accountId: 'toolworks-cash',
        recipeId: 'toolmaking',
        laborPerBatch: 1,
        maxBatches: 1,
        wagePerBatch: 2,
      },
    ],
    cohorts: [
      {
        id: 'coast-families',
        cityId: cities[0],
        ownerId: 'households-coast',
        accountId: 'coast-households-cash',
        workersAvailable: 4,
        desiredNeeds: { grain: 4 },
      },
      {
        id: 'inland-families',
        cityId: cities[1],
        ownerId: 'households-inland',
        accountId: 'inland-households-cash',
        workersAvailable: 3,
        desiredNeeds: { tools: 1 },
      },
    ],
    sellers: [
      {
        cityId: cities[0],
        commodity: 'grain',
        ownerId: 'grain-farm',
        accountId: 'grain-farm-cash',
        minPrice: 1,
        maxPrice: 30,
        openingPrice: 20,
      },
      {
        cityId: cities[1],
        commodity: 'tools',
        ownerId: 'toolworks',
        accountId: 'toolworks-cash',
        minPrice: 1,
        maxPrice: 30,
        openingPrice: 8,
      },
    ],
  };
  registerLocalEconomy(engine, economy);
  registerLogistics(engine, {
    ...ledger,
    transitOwnerId: 'transit',
    cities: [...cities],
    cityOwnerIds: { [cities[0]]: 'woodlot', [cities[1]]: 'toolworks' },
    routes: [
      {
        routeId: 'coast-inland-freight',
        sourceCityId: cities[0],
        destinationCityId: cities[1],
        travelTicks: 3,
        capacity: 1000,
        fare: 2,
        carrierAccountId: 'carrier-cash',
      },
    ],
  });
  for (let tick = 2, shipment = 1; tick <= ticks; tick += 10, shipment++) {
    engine.submit({
      commandId: `wood-departure-${shipment}`,
      type: 'logistics.depart',
      requestedTick: tick,
      payload: {
        shipmentId: `wood-shipment-${shipment}`,
        routeId: 'coast-inland-freight',
        commodity: 'wood',
        quantity: 1,
        buyerAccountId: 'toolworks-cash',
        payment: 2,
      },
    });
  }
  const tradePrice = 3;
  engine.registerPhaseSystem('publish', 'scenario:wood-trade-settlement', (draft) => {
    const logisticsState = draft.logistics as {
      shipments: Array<{
        shipmentId: string;
        status: string;
        arrivalTick: number;
        quantity: number;
      }>;
    };
    let accounting = draft.accounting as AccountingState;
    for (const shipment of logisticsState.shipments) {
      if (shipment.status !== 'arrived') continue;
      const causeId = `wood-trade:${shipment.shipmentId}`;
      if (accounting.journal.some((entry) => entry.causeId === causeId)) continue;
      accounting = applyAccountingTransaction(
        accounting,
        [
          {
            type: 'payment',
            fromAccountId: 'toolworks-cash',
            toAccountId: 'woodlot-cash',
            amount: {
              kind: 'money',
              currencyId: 'coin',
              unit: 'coin',
              scale: 0,
              minor: tradePrice * shipment.quantity,
            },
            causeId,
          },
        ],
        `wood-trade-settlement:${shipment.shipmentId}`,
      );
    }
    draft.accounting = accounting;
  });
  const openingTotal = ledger.accounts.reduce(
    (total, account) => total + account.openingBalance,
    0,
  );
  const arrivalEvidence = new Map<
    string,
    { inTransit: boolean; destinationEmpty: boolean; deliveredWood: number }
  >();
  const priceHistory: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const before = engine.getState().domain;
    const beforeLogistics = before.logistics as
      | {
          shipments: Array<{
            shipmentId: string;
            status: string;
            arrivalTick: number;
            quantity: number;
          }>;
        }
      | undefined;
    const beforeAccounting = before.accounting as AccountingState | undefined;
    for (const shipment of beforeLogistics?.shipments ?? []) {
      if (shipment.status !== 'in-transit' || shipment.arrivalTick !== i + 1) continue;
      const transit = beforeAccounting?.stock.find(
        (item) => item.location === 'transit' && item.shipmentId === shipment.shipmentId,
      );
      const destinationQuantity = (beforeAccounting?.stock ?? [])
        .filter(
          (item) =>
            item.ownerId === 'toolworks' &&
            item.commodity === 'wood' &&
            item.location === 'available',
        )
        .reduce((sum, item) => sum + item.quantity, 0);
      arrivalEvidence.set(shipment.shipmentId, {
        inTransit: !!transit && transit.quantity === shipment.quantity,
        destinationEmpty: destinationQuantity === 0,
        deliveredWood: 0,
      });
    }
    const view = engine.step();
    const state = view.domain;
    const logisticsAfterTick = state.logistics as {
      shipments: Array<{ shipmentId: string; status: string; quantity: number }>;
    };
    for (const shipment of logisticsAfterTick.shipments) {
      const evidence = arrivalEvidence.get(shipment.shipmentId);
      if (evidence && shipment.status === 'arrived') evidence.deliveredWood = shipment.quantity;
    }
    const economyState = state.economy as { sellers: Record<string, { price: number }> };
    priceHistory.push(economyState.sellers['["grain-coast","grain"]']!.price);
  }
  const view = engine.getState();
  const accounting = view.domain.accounting as AccountingState;
  const logistics = view.domain.logistics as {
    shipments: Array<{
      shipmentId: string;
      status: string;
      arrivalTick: number;
      departureTick: number;
      quantity: number;
    }>;
  };
  const economyState = view.domain.economy as {
    producers: Record<string, { batches: number }>;
    sellers: Record<string, { price: number }>;
    cohorts: Record<string, { cumulativeUnmet: Record<string, number> }>;
  };
  const journal = accounting.journal;
  const paymentEntries = journal.filter((entry) => entry.type === 'payment');
  const tradePayments = paymentEntries.filter((entry) => {
    const effect = entry.effects[0] as { debit?: string; credit?: string };
    return (
      entry.causeId.startsWith('wood-trade:') &&
      effect.debit === 'toolworks-cash' &&
      effect.credit === 'woodlot-cash'
    );
  });
  const payments = {
    trade: tradePayments.length,
    wages: paymentEntries.filter((entry) => {
      const effect = entry.effects[0] as { debit?: string; credit?: string };
      return entry.causeId.startsWith('wage:') && effect.credit?.includes('households');
    }).length,
    localPurchases: paymentEntries.filter((entry) => {
      const effect = entry.effects[0] as { debit?: string; credit?: string };
      return entry.causeId.startsWith('purchase:') && effect.debit?.includes('households');
    }).length,
    freight: paymentEntries.filter((entry) => {
      const effect = entry.effects[0] as { debit?: string; credit?: string };
      return entry.causeId.endsWith(':fare') && effect.credit === 'carrier-cash';
    }).length,
  };
  const total = accounting.accounts.reduce((sum, account) => sum + account.balance, 0);
  const reports = (): InitialTwoCitiesReport => ({
    ticks,
    cities,
    goods,
    production: {
      grain: journal.filter(
        (entry) =>
          entry.type === 'conversion' &&
          (entry.effects[0] as { recipeId?: string }).recipeId === 'grain-growing',
      ).length,
      wood: journal.filter(
        (entry) =>
          entry.type === 'conversion' &&
          (entry.effects[0] as { recipeId?: string }).recipeId === 'wood-cutting',
      ).length,
      tools: journal.filter(
        (entry) =>
          entry.type === 'conversion' &&
          (entry.effects[0] as { recipeId?: string }).recipeId === 'toolmaking',
      ).length,
    },
    trade: {
      departed: logistics.shipments.length,
      arrived: logistics.shipments.filter((s) => s.status === 'arrived').length,
      firstDepartureTick: logistics.shipments[0]?.departureTick ?? 0,
      firstArrivalTick: logistics.shipments.find((s) => s.status === 'arrived')?.arrivalTick ?? 0,
      woodQuantity: logistics.shipments
        .filter((s) => s.status === 'arrived')
        .reduce((sum, shipment) => sum + shipment.quantity, 0),
      unitPrice: tradePrice,
      paidTotal: tradePayments.reduce(
        (sum, entry) => sum + ((entry.effects[0] as { amount?: number }).amount ?? 0),
        0,
      ),
      paymentCount: tradePayments.length,
      paymentPartiesValid: tradePayments.every((entry) => {
        const effect = entry.effects[0] as { debit?: string; credit?: string };
        return effect.debit === 'toolworks-cash' && effect.credit === 'woodlot-cash';
      }),
      arrivalsPaidAfterDelivery: logistics.shipments
        .filter((s) => s.status === 'arrived')
        .every((shipment) => {
          const arrivalIndex = journal.findIndex(
            (entry) =>
              entry.type === 'arrive' &&
              entry.effects.some(
                (effect) => (effect as { arrive?: string }).arrive === shipment.shipmentId,
              ),
          );
          const paymentIndex = journal.findIndex(
            (entry) => entry.causeId === `wood-trade:${shipment.shipmentId}`,
          );
          return arrivalIndex >= 0 && paymentIndex > arrivalIndex;
        }),
    },
    payments,
    paymentJournalEntries: paymentEntries.length,
    effects: [...new Set(journal.map((entry) => entry.type))].sort(),
    causes: [...new Set(journal.map((entry) => entry.causeId))].sort(),
    prices: priceHistory,
    stock: {
      nonnegative: accounting.stock.every((item) => item.quantity >= 0),
      final: accounting.stock.map(({ ownerId, commodity, quantity }) => ({
        ownerId,
        commodity,
        quantity,
      })),
    },
    money: {
      nonnegative: accounting.accounts.every((account) => account.balance >= 0),
      total,
      openingTotal,
    },
    shipments: logistics.shipments.map((shipment) => {
      const evidence = arrivalEvidence.get(shipment.shipmentId);
      return {
        status: shipment.status,
        inTransitImmediatelyBeforeArrival: evidence?.inTransit ?? false,
        destinationEmptyImmediatelyBeforeArrival: evidence?.destinationEmpty ?? false,
        deliveredWood: evidence?.deliveredWood ?? 0,
        paidWood:
          shipment.status === 'arrived' &&
          tradePayments.some((entry) => entry.causeId === `wood-trade:${shipment.shipmentId}`)
            ? shipment.quantity
            : 0,
      };
    }),
    hashes: { state: view.hash, events: view.eventHash },
    unmetNeeds: Object.fromEntries(
      Object.entries(economyState.cohorts).flatMap(([cohort, state]) =>
        Object.entries(state.cumulativeUnmet).map(([commodity, amount]) => [
          `${cohort}:${commodity}`,
          amount,
        ]),
      ),
    ),
  });
  return { report: reports };
}
