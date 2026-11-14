import { describe, expect, it } from 'vitest';
import {
  createInventory,
  createMoneyLedger,
  createPaidShipmentCoordinator,
  createRouteNetwork,
} from '../../packages/simulation-core/src/index.js';

const makeShipmentSystem = () => {
  const inventory = createInventory({
    owners: ['north', 'south', 'transit'],
    balances: [{ ownerId: 'north', commodity: 'grain', quantity: 5 }],
  });
  const money = createMoneyLedger({
    accounts: ['buyer-cash', 'seller-cash'],
    balances: [{ accountId: 'buyer-cash', amount: 50 }],
  });
  const network = createRouteNetwork({
    cityIds: ['north', 'south'],
    transitOwnerId: 'transit',
    inventory,
    routes: [
      { routeId: 'road', sourceCityId: 'north', destinationCityId: 'south', travelTicks: 2 },
    ],
  });
  const coordinator = createPaidShipmentCoordinator({ inventory, money, network });
  return { inventory, money, network, coordinator };
};

describe('paid shipments', () => {
  it('atomically departs goods and settles the caller-supplied payment', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();

    const receipt = coordinator.depart({
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 17,
    });

    expect(receipt.payment).toBe(17);
    expect(network.getState().shipments).toMatchObject([
      { shipmentId: 'load-1', status: 'in-transit', departureTick: 0, arrivalTick: 2 },
    ]);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 3 },
      { ownerId: 'transit', commodity: 'grain', quantity: 2 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
  });

  it('leaves inventory, money, and shipment state unchanged when payment preparation fails', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 51,
      }),
    ).toThrow(/funds/);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('does not mutate earlier participants when shipment preparation fails', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'missing', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'seller-cash',
        payment: 17,
      }),
    ).toThrow(/route/);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('allows ordinary route networks with custom inventory but rejects them for paid coordination', () => {
    const inventory = createInventory({ owners: ['north', 'south', 'transit'] });
    const foreignInventory = {
      hasOwner: inventory.hasOwner.bind(inventory),
      getState: inventory.getState.bind(inventory),
      transfer: inventory.transfer.bind(inventory),
      consume: inventory.consume.bind(inventory),
      produce: inventory.produce.bind(inventory),
    };
    const network = createRouteNetwork({
      cityIds: ['north', 'south'],
      transitOwnerId: 'transit',
      inventory: foreignInventory,
    });
    const money = createMoneyLedger({ accounts: ['buyer', 'seller'] });

    expect(() =>
      createPaidShipmentCoordinator({ inventory: foreignInventory, money, network }),
    ).toThrow(/built-in coordinator participants/i);
  });

  it('snapshots coordinator references before participant lookup and identity checks', () => {
    const { inventory, money, network } = makeShipmentSystem();
    const unrelatedInventory = createInventory({ owners: ['north', 'south', 'transit'] });
    let inventoryReads = 0;
    const input = {
      get inventory() {
        inventoryReads += 1;
        return inventoryReads === 1 ? inventory : unrelatedInventory;
      },
      money,
      network,
    };

    expect(() => createPaidShipmentCoordinator(input)).not.toThrow();
    expect(inventoryReads).toBe(1);
  });

  it('rejects a network coordinated with a different inventory instance', () => {
    const { money, network } = makeShipmentSystem();
    const unrelatedInventory = createInventory({ owners: ['north', 'south', 'transit'] });

    expect(() =>
      createPaidShipmentCoordinator({ inventory: unrelatedInventory, money, network }),
    ).toThrow(/same inventory|bound inventory/i);
    expect(unrelatedInventory.getState().balances).toEqual([]);
  });

  it('snapshots all input getters before preparing participant state', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    let buyerReads = 0;
    const paidShipment = {
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain' as const, quantity: 2 },
      get buyerAccountId() {
        buyerReads += 1;
        inventory.transfer('north', 'south', 'grain', 1);
        return 'buyer-cash';
      },
      sellerAccountId: 'seller-cash',
      payment: 17,
    };

    const receipt = coordinator.depart(paidShipment);

    expect(buyerReads).toBe(1);
    expect(receipt.payment).toBe(17);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 2 },
      { ownerId: 'south', commodity: 'grain', quantity: 1 },
      { ownerId: 'transit', commodity: 'grain', quantity: 2 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
    expect(network.getState().shipments).toHaveLength(1);
  });

  it('uses one payment snapshot for settlement and receipt', () => {
    const { money, coordinator } = makeShipmentSystem();
    let paymentReads = 0;
    const input = {
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain' as const, quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      get payment() {
        paymentReads += 1;
        return paymentReads === 1 ? 17 : 19;
      },
    };

    const receipt = coordinator.depart(input);

    expect(paymentReads).toBe(1);
    expect(receipt.payment).toBe(17);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 33 },
      { accountId: 'seller-cash', amount: 17 },
    ]);
  });

  it('does not trust replaceable public route state for the shipment source', () => {
    const { inventory, network, coordinator } = makeShipmentSystem();
    network.getState = () => ({
      tick: 0,
      routes: [
        { routeId: 'road', sourceCityId: 'south', destinationCityId: 'north', travelTicks: 2 },
      ],
      shipments: [],
    });

    coordinator.depart({
      shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
      buyerAccountId: 'buyer-cash',
      sellerAccountId: 'seller-cash',
      payment: 17,
    });

    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'north',
      commodity: 'grain',
      quantity: 3,
    });
    expect(inventory.getState().balances).toContainEqual({
      ownerId: 'transit',
      commodity: 'grain',
      quantity: 2,
    });
  });

  it('rejects a shipment paid to the same account without mutating state', () => {
    const { inventory, money, network, coordinator } = makeShipmentSystem();
    const before = {
      inventory: inventory.getState(),
      money: money.getState(),
      network: network.getState(),
    };

    expect(() =>
      coordinator.depart({
        shipment: { shipmentId: 'load-1', routeId: 'road', commodity: 'grain', quantity: 2 },
        buyerAccountId: 'buyer-cash',
        sellerAccountId: 'buyer-cash',
        payment: 17,
      }),
    ).toThrow(/distinct|same account/i);
    expect(inventory.getState()).toEqual(before.inventory);
    expect(money.getState()).toEqual(before.money);
    expect(network.getState()).toEqual(before.network);
  });

  it('rejects foreign ledgers whose atomic commit capability cannot be verified', () => {
    const { inventory, money, network } = makeShipmentSystem();
    const foreignMoney = {
      getState: money.getState,
      transfer: money.transfer,
    };

    expect(() =>
      createPaidShipmentCoordinator({ inventory, money: foreignMoney, network }),
    ).toThrow(/atomic|built-in|coordinator/i);
    expect(inventory.getState().balances).toEqual([
      { ownerId: 'north', commodity: 'grain', quantity: 5 },
    ]);
    expect(money.getState().balances).toEqual([
      { accountId: 'buyer-cash', amount: 50 },
      { accountId: 'seller-cash', amount: 0 },
    ]);
  });
});
