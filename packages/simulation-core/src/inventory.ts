import { COMMODITIES, type Commodity } from './commodity.js';

export interface InventoryBalanceInput {
  readonly ownerId: string;
  readonly commodity: Commodity;
  readonly quantity: number;
}

export interface InventoryInput {
  readonly owners: readonly string[];
  readonly balances?: readonly InventoryBalanceInput[];
}

export type InventoryBalance = InventoryBalanceInput;

export interface InventorySnapshot {
  readonly balances: readonly InventoryBalance[];
}

export interface Inventory {
  getState(): InventorySnapshot;
  transfer(
    fromOwnerId: string,
    toOwnerId: string,
    commodity: Commodity,
    quantity: number,
  ): InventorySnapshot;
}

export function createInventory(input: InventoryInput): Inventory {
  const owners = new Set<string>();
  const balances = new Map<string, number>();
  const key = (ownerId: string, commodity: Commodity): string => `${ownerId}\0${commodity}`;
  const validateOwnerId = (ownerId: string): void => {
    if (typeof ownerId !== 'string') throw new TypeError('owner id must be a string');
    if (ownerId.length === 0) throw new RangeError('owner id must be nonempty');
  };
  const validateQuantity = (quantity: number): void => {
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || !Number.isInteger(quantity)) {
      throw new TypeError('quantity must be a finite integer');
    }
    if (quantity < 0 || !Number.isSafeInteger(quantity)) {
      throw new RangeError('quantity must be a nonnegative safe integer');
    }
  };
  const validateCommodity = (commodity: Commodity): void => {
    if (!(COMMODITIES as readonly string[]).includes(commodity)) {
      throw new RangeError(`unknown commodity: ${commodity}`);
    }
  };

  for (const ownerId of input.owners) {
    validateOwnerId(ownerId);
    if (owners.has(ownerId)) throw new RangeError(`duplicate owner id: ${ownerId}`);
    owners.add(ownerId);
  }
  for (const balance of input.balances ?? []) {
    validateOwnerId(balance.ownerId);
    if (!owners.has(balance.ownerId)) throw new RangeError(`unknown owner: ${balance.ownerId}`);
    validateCommodity(balance.commodity);
    validateQuantity(balance.quantity);
    const balanceKey = key(balance.ownerId, balance.commodity);
    if (balances.has(balanceKey)) throw new RangeError('duplicate inventory balance');
    balances.set(balanceKey, balance.quantity);
  }

  const snapshot = (): InventorySnapshot => ({
    balances: [...owners].flatMap((ownerId) =>
      COMMODITIES.flatMap((commodity) => {
        const quantity = balances.get(key(ownerId, commodity)) ?? 0;
        return quantity === 0 ? [] : [{ ownerId, commodity, quantity }];
      }),
    ),
  });

  return {
    getState: snapshot,
    transfer: (fromOwnerId, toOwnerId, commodity, quantity) => {
      if (!owners.has(fromOwnerId)) throw new RangeError(`unknown source owner: ${fromOwnerId}`);
      if (!owners.has(toOwnerId)) throw new RangeError(`unknown destination owner: ${toOwnerId}`);
      validateCommodity(commodity);
      if (
        typeof quantity !== 'number' ||
        !Number.isFinite(quantity) ||
        !Number.isInteger(quantity)
      ) {
        throw new TypeError('quantity must be a finite integer');
      }
      if (quantity <= 0 || !Number.isSafeInteger(quantity)) {
        throw new RangeError('transfer quantity must be a positive safe integer');
      }
      if (fromOwnerId === toOwnerId) return snapshot();
      const sourceKey = key(fromOwnerId, commodity);
      const destinationKey = key(toOwnerId, commodity);
      const sourceBalance = balances.get(sourceKey) ?? 0;
      const destinationBalance = balances.get(destinationKey) ?? 0;
      if (sourceBalance < quantity) throw new RangeError('insufficient inventory');
      if (quantity > Number.MAX_SAFE_INTEGER - destinationBalance) {
        throw new RangeError('destination inventory would exceed Number.MAX_SAFE_INTEGER');
      }
      balances.set(sourceKey, sourceBalance - quantity);
      balances.set(destinationKey, destinationBalance + quantity);
      return snapshot();
    },
  };
}
