import { checkedAdd } from '../../shared/integer.js';
import type { MoneyUnit, CommodityQuantity } from '../../models/units.js';
import { DomainCommandRejection } from '../../models/commands.js';

export interface AccountingConfig {
  readonly currency: { readonly id: string; readonly unit: string; readonly scale: number };
  readonly commodities: readonly {
    readonly id: string;
    readonly unit: string;
    readonly scale: number;
  }[];
  readonly owners: readonly string[];
  readonly accounts: readonly {
    readonly id: string;
    readonly ownerId: string;
    /** Trusted opening balance expressed in the configured currency's minor units. */
    readonly openingBalance: number;
  }[];
  readonly recipes?: readonly {
    readonly id: string;
    readonly inputs: readonly { readonly commodity: string; readonly quantity: number }[];
    readonly outputs: readonly { readonly commodity: string; readonly quantity: number }[];
  }[];
  readonly stock?: readonly {
    readonly ownerId: string;
    readonly commodity: string;
    /** Trusted opening quantity expressed in the commodity's configured scale. */
    readonly quantity: number;
    readonly scale?: number;
  }[];
}
export interface AccountingAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly balance: number;
}
export interface AccountingStock {
  readonly ownerId: string;
  readonly commodity: string;
  readonly location: 'available' | 'reserved' | 'transit';
  readonly quantity: number;
  readonly reservationId?: string;
  readonly shipmentId?: string;
}
export interface AccountingJournalEntry {
  readonly transactionId: string;
  readonly causeId: string;
  readonly type: string;
  readonly effects: readonly unknown[];
  readonly rationale: string;
}
export interface AccountingState {
  readonly version: 1;
  readonly currency: AccountingConfig['currency'];
  readonly commodities: AccountingConfig['commodities'];
  readonly owners: readonly string[];
  readonly accounts: readonly AccountingAccount[];
  readonly stock: readonly AccountingStock[];
  readonly journal: readonly AccountingJournalEntry[];
  readonly openingBalances: readonly { readonly accountId: string; readonly balance: number }[];
  readonly openingStock: readonly AccountingStock[];
  readonly recipes: readonly {
    readonly id: string;
    readonly inputs: readonly Line[];
    readonly outputs: readonly Line[];
  }[];
}
export type StockLocation = 'available' | 'reserved' | 'transit';
type Line = { readonly commodity: string; readonly quantity: number };
export type AccountingOperation =
  | {
      readonly type: 'payment';
      readonly fromAccountId: string;
      readonly toAccountId: string;
      readonly amount: MoneyUnit;
      readonly causeId: string;
    }
  | {
      readonly type: 'transfer';
      readonly ownerId: string;
      readonly toOwnerId: string;
      readonly commodity: string;
      readonly quantity: CommodityQuantity;
      readonly from: 'available';
      readonly to: 'available';
      readonly causeId: string;
    }
  | {
      readonly type: 'reserve';
      readonly ownerId: string;
      readonly commodity: string;
      readonly quantity: CommodityQuantity;
      readonly reservationId: string;
      readonly causeId: string;
    }
  | { readonly type: 'release'; readonly reservationId: string; readonly causeId: string }
  | {
      readonly type: 'depart';
      readonly reservationId: string;
      readonly shipmentId: string;
      readonly causeId: string;
    }
  | {
      readonly type: 'arrive';
      readonly shipmentId: string;
      readonly toOwnerId: string;
      readonly causeId: string;
    }
  | {
      readonly type: 'consume' | 'loss';
      readonly ownerId: string;
      readonly commodity: string;
      readonly quantity: CommodityQuantity;
      readonly causeId: string;
      readonly rationale?: string;
    }
  | {
      readonly type: 'conversion';
      readonly ownerId: string;
      readonly recipeId: string;
      readonly inputs: readonly Line[];
      readonly outputs: readonly Line[];
      readonly causeId: string;
    }
  | {
      readonly type: 'inventory-transfer';
      readonly ownerId: string;
      readonly toOwnerId: string;
      readonly commodity: string;
      readonly quantity: CommodityQuantity;
      readonly causeId: string;
    };

function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty`);
}
function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
}

function validateRecipes(
  recipes: NonNullable<AccountingConfig['recipes']>,
  commodityIds: ReadonlySet<string>,
  clone: boolean,
): AccountingState['recipes'] {
  if (!Array.isArray(recipes)) throw new TypeError('recipes must be an array');
  const seen = new Set<string>();
  return recipes.map((recipe) => {
    id(recipe.id, 'recipe id');
    if (seen.has(recipe.id)) throw new RangeError('duplicate recipe ID');
    seen.add(recipe.id);
    for (const lines of [recipe.inputs, recipe.outputs]) {
      if (!Array.isArray(lines) || lines.length === 0)
        throw new RangeError('recipe lines must be nonempty');
      const lineIds = new Set<string>();
      for (const line of lines) {
        id(line.commodity, 'recipe commodity');
        positive(line.quantity, 'recipe quantity');
        if (!commodityIds.has(line.commodity))
          throw new RangeError(`unknown commodity: ${line.commodity}`);
        if (lineIds.has(line.commodity)) throw new RangeError('duplicate recipe line');
        lineIds.add(line.commodity);
      }
    }
    return clone ? structuredClone(recipe) : recipe;
  });
}

function quantityValue(
  value: CommodityQuantity,
  commodityId: string,
  definitions: AccountingState['commodities'],
): number {
  const definition = definitions.find((item) => item.id === commodityId);
  if (!definition) throw new RangeError(`unknown commodity: ${commodityId}`);
  if (typeof value === 'number') throw new TypeError('commodity quantity value object required');
  if (
    !value ||
    value.kind !== 'commodity' ||
    value.commodityId !== commodityId ||
    value.unit !== definition.unit ||
    value.scale !== definition.scale
  )
    throw new RangeError('commodity identity/unit/scale mismatch');
  return value.quantity;
}

function moneyValue(value: MoneyUnit, state: AccountingState): number {
  if (typeof value === 'number') throw new TypeError('money value object required');
  if (
    !value ||
    value.kind !== 'money' ||
    value.currencyId !== state.currency.id ||
    value.unit !== state.currency.unit ||
    value.scale !== state.currency.scale
  )
    throw new RangeError('currency identity/unit/scale mismatch');
  return value.minor;
}
function validScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 12)
    throw new RangeError('scale must be an integer from 0 to 12');
}

export function createAccountingState(config: AccountingConfig): AccountingState {
  if (
    !config ||
    !config.currency ||
    !Array.isArray(config.owners) ||
    !Array.isArray(config.accounts)
  )
    throw new TypeError('invalid accounting opening config');
  id(config.currency.id, 'currency id');
  id(config.currency.unit, 'currency unit');
  validScale(config.currency.scale);
  const owners = [...config.owners];
  if (new Set(owners).size !== owners.length) throw new RangeError('duplicate owner');
  owners.forEach((owner) => id(owner, 'owner id'));
  const commodities = config.commodities.map((item) => {
    id(item.id, 'commodity id');
    id(item.unit, 'commodity unit');
    validScale(item.scale);
    return { ...item };
  });
  if (new Set(commodities.map((item) => item.id)).size !== commodities.length)
    throw new RangeError('duplicate commodity');
  const accounts = config.accounts.map((account) => {
    id(account.id, 'account id');
    if (!owners.includes(account.ownerId)) throw new RangeError('unknown account owner');
    if (!Number.isSafeInteger(account.openingBalance) || account.openingBalance < 0)
      throw new RangeError('invalid trusted opening balance');
    return { id: account.id, ownerId: account.ownerId, balance: account.openingBalance };
  });
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length)
    throw new RangeError('duplicate account');
  const openingStockKeys = new Set<string>();
  const stock: AccountingStock[] = (config.stock ?? []).map((item) => {
    if (!owners.includes(item.ownerId)) throw new RangeError('unknown stock owner');
    const commodity = commodities.find((entry) => entry.id === item.commodity);
    if (!commodity) throw new RangeError(`unknown commodity: ${item.commodity}`);
    if (item.scale !== undefined && item.scale !== commodity.scale)
      throw new RangeError('commodity scale mismatch');
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)
      throw new RangeError('invalid opening quantity');
    const key = `${item.ownerId}\u0000${item.commodity}`;
    if (openingStockKeys.has(key)) throw new RangeError('duplicate opening stock');
    openingStockKeys.add(key);
    return {
      ownerId: item.ownerId,
      commodity: item.commodity,
      location: 'available',
      quantity: item.quantity,
    };
  });
  const initial: AccountingState = {
    version: 1,
    currency: { ...config.currency },
    commodities,
    owners,
    accounts,
    stock: stock.filter((item) => item.quantity > 0),
    journal: [],
    openingBalances: accounts.map(({ id, balance }) => ({ accountId: id, balance })),
    openingStock: stock.filter((item) => item.quantity > 0).map((item) => ({ ...item })),
    recipes: validateRecipes(
      config.recipes ?? [],
      new Set(commodities.map((item) => item.id)),
      true,
    ),
  };
  assertAccountingInvariant(initial);
  return initial;
}

export function assertAccountingInvariant(state: AccountingState): void {
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.accounts) ||
    !Array.isArray(state.stock) ||
    !Array.isArray(state.journal)
  )
    throw new TypeError('invalid accounting state');
  id(state.currency.id, 'currency id');
  id(state.currency.unit, 'currency unit');
  validScale(state.currency.scale);
  if (new Set(state.owners).size !== state.owners.length) throw new RangeError('duplicate owner');
  state.owners.forEach((owner) => id(owner, 'owner id'));
  for (const commodity of state.commodities) {
    id(commodity.id, 'commodity id');
    id(commodity.unit, 'commodity unit');
    validScale(commodity.scale);
  }
  if (new Set(state.commodities.map((item) => item.id)).size !== state.commodities.length)
    throw new RangeError('duplicate commodity');
  const owners = new Set(state.owners);
  const accountIds = new Set<string>();
  for (const account of state.accounts) {
    id(account.id, 'account id');
    if (
      accountIds.has(account.id) ||
      !owners.has(account.ownerId) ||
      !Number.isSafeInteger(account.balance) ||
      account.balance < 0
    )
      throw new RangeError('invalid accounting account/balance');
    accountIds.add(account.id);
  }
  const commodities = new Set(state.commodities.map((commodity) => commodity.id));
  const stockKeys = new Set<string>();
  for (const item of state.stock) {
    if (
      !owners.has(item.ownerId) ||
      !commodities.has(item.commodity) ||
      !['available', 'reserved', 'transit'].includes(item.location) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      (item.location === 'available' &&
        (item.reservationId !== undefined || item.shipmentId !== undefined)) ||
      (item.location === 'reserved' && (!item.reservationId || item.shipmentId !== undefined)) ||
      (item.location === 'transit' && (!item.shipmentId || item.reservationId !== undefined))
    )
      throw new RangeError('invalid accounting stock');
    const stockKey = `${item.ownerId}\u0000${item.commodity}\u0000${item.location}\u0000${item.reservationId ?? item.shipmentId ?? ''}`;
    if (stockKeys.has(stockKey)) throw new RangeError('duplicate accounting stock location');
    stockKeys.add(stockKey);
  }
  if (
    !Array.isArray(state.openingBalances) ||
    !Array.isArray(state.openingStock) ||
    !Array.isArray(state.recipes)
  )
    throw new TypeError('missing trusted opening balances/stock or recipe config');
  validateRecipes(state.recipes, commodities, false);
  const replay = new Map(
    state.openingBalances.map(({ accountId, balance }) => [accountId, balance]),
  );
  if (
    replay.size !== state.accounts.length ||
    state.accounts.some((account) => !replay.has(account.id))
  )
    throw new RangeError('opening accounts do not match current accounts');
  const stockReplay = new Map<string, bigint>();
  const stockKey = (item: { ownerId: string; commodity: string; location: string; ref?: string }) =>
    `${item.ownerId}\u0000${item.commodity}\u0000${item.location}\u0000${item.ref ?? ''}`;
  for (const item of state.openingStock) {
    if (
      !owners.has(item.ownerId) ||
      !commodities.has(item.commodity) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      (item.location === 'available' &&
        (item.reservationId !== undefined || item.shipmentId !== undefined)) ||
      (item.location === 'reserved' && (!item.reservationId || item.shipmentId !== undefined)) ||
      (item.location === 'transit' && (!item.shipmentId || item.reservationId !== undefined))
    )
      throw new RangeError('invalid opening stock baseline');
    const key = stockKey({ ...item, ref: item.reservationId ?? item.shipmentId });
    if (stockReplay.has(key)) throw new RangeError('duplicate opening stock location');
    stockReplay.set(key, BigInt(item.quantity));
  }
  const usedIds = new Set<string>();
  const closedTransactions = new Set<string>();
  let activeTransaction: string | undefined;
  for (const entry of state.journal) {
    id(entry.transactionId, 'journal transaction id');
    id(entry.causeId, 'journal cause id');
    if (activeTransaction !== entry.transactionId) {
      if (closedTransactions.has(entry.transactionId))
        throw new RangeError('duplicate transaction ID');
      if (activeTransaction) closedTransactions.add(activeTransaction);
      activeTransaction = entry.transactionId;
    }
    const allowed = [
      'payment',
      'reserve',
      'release',
      'depart',
      'arrive',
      'transfer',
      'inventory-transfer',
      'consume',
      'loss',
      'conversion',
    ];
    if (
      !allowed.includes(entry.type) ||
      !Array.isArray(entry.effects) ||
      entry.effects.length !== 1
    )
      throw new RangeError('unknown or malformed journal effect');
    const effect = entry.effects[0] as Record<string, unknown>;
    const hasId = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    if (
      (entry.type === 'reserve' && !hasId(effect.reservationId)) ||
      (entry.type === 'release' && !hasId(effect.release)) ||
      (entry.type === 'depart' && (!hasId(effect.depart) || !hasId(effect.shipmentId))) ||
      (entry.type === 'arrive' && (!hasId(effect.arrive) || !hasId(effect.destination))) ||
      ((entry.type === 'transfer' || entry.type === 'inventory-transfer') &&
        (!hasId(effect.from) ||
          !hasId(effect.to) ||
          !hasId(effect.commodity) ||
          !Number.isSafeInteger(effect.quantity) ||
          (effect.quantity as number) <= 0)) ||
      ((entry.type === 'consume' || entry.type === 'loss') &&
        (!hasId(effect.ownerId) ||
          !hasId(effect.commodity) ||
          !Number.isSafeInteger(effect[entry.type]) ||
          (effect[entry.type] as number) <= 0)) ||
      (entry.type === 'conversion' &&
        (!hasId(effect.recipeId) ||
          !Array.isArray(effect.inputs) ||
          !Array.isArray(effect.outputs)))
    )
      throw new RangeError('malformed journal effect');
    if (entry.type === 'payment') {
      const debit = effect.debit,
        credit = effect.credit,
        amount = effect.amount;
      if (
        typeof debit !== 'string' ||
        typeof credit !== 'string' ||
        debit === credit ||
        !Number.isSafeInteger(amount) ||
        (amount as number) <= 0 ||
        !replay.has(debit) ||
        !replay.has(credit)
      )
        throw new RangeError('invalid payment journal entry');
      replay.set(debit, checkedAdd(replay.get(debit)!, -(amount as number)));
      replay.set(credit, checkedAdd(replay.get(credit)!, amount as number));
      if (replay.get(debit)! < 0) throw new RangeError('journal overdrafts account');
    }
    if (entry.type === 'reserve' && typeof effect.reservationId === 'string') {
      if (usedIds.has(`r:${effect.reservationId}`)) throw new RangeError('reservation ID reused');
      usedIds.add(`r:${effect.reservationId}`);
    }
    if (entry.type === 'depart' && typeof effect.shipmentId === 'string') {
      if (usedIds.has(`s:${effect.shipmentId}`)) throw new RangeError('shipment ID reused');
      usedIds.add(`s:${effect.shipmentId}`);
    }
    if (!Array.isArray(effect.stockDeltas)) throw new RangeError('missing stock provenance');
    for (const delta of effect.stockDeltas as Array<{
      ownerId: string;
      commodity: string;
      location: string;
      ref?: string;
      delta: number;
    }>) {
      if (
        !owners.has(delta.ownerId) ||
        !commodities.has(delta.commodity) ||
        !['available', 'reserved', 'transit'].includes(delta.location) ||
        !Number.isSafeInteger(delta.delta) ||
        delta.delta === 0
      )
        throw new RangeError('malformed stock journal effect');
      const key = stockKey(delta);
      const value = (stockReplay.get(key) ?? 0n) + BigInt(delta.delta);
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        throw new RangeError('stock journal overflow/negative balance');
      if (value === 0n) stockReplay.delete(key);
      else stockReplay.set(key, value);
    }
  }
  if (state.accounts.some((account) => replay.get(account.id) !== account.balance))
    throw new RangeError('money does not reconcile to opening balances and journal');
  const currentStock = new Map(
    state.stock.map((item) => [
      stockKey({ ...item, ref: item.reservationId ?? item.shipmentId }),
      BigInt(item.quantity),
    ]),
  );
  if (
    stockReplay.size !== currentStock.size ||
    [...stockReplay].some(([key, quantity]) => currentStock.get(key) !== quantity)
  )
    throw new RangeError('stock does not reconcile to opening stock and journal');
}

export function applyAccountingTransaction(
  state: AccountingState,
  operations: readonly AccountingOperation[],
  transactionId: string,
): AccountingState {
  assertAccountingInvariant(state);
  id(transactionId, 'transaction id');
  if (!Array.isArray(operations) || operations.length === 0)
    throw new RangeError('transaction operations must be nonempty');
  const safeOperations = structuredClone(operations).map((operation) => {
    if (operation.type === 'payment') {
      return { ...operation, amount: moneyValue(operation.amount, state) };
    }
    if (['transfer', 'inventory-transfer', 'reserve', 'consume', 'loss'].includes(operation.type)) {
      const quantity = quantityValue(operation.quantity, operation.commodity, state.commodities);
      return { ...operation, quantity };
    }
    return operation;
  }) as AccountingOperation[];
  const accounts = state.accounts.map((item) => ({ ...item }));
  const stock = state.stock.map((item) => ({ ...item }));
  const journal: AccountingJournalEntry[] = state.journal.map((entry) => structuredClone(entry));
  if (journal.some((entry) => entry.transactionId === transactionId))
    throw new RangeError('duplicate transaction ID');
  const stockDef = (commodity: string) => {
    const found = state.commodities.find((item) => item.id === commodity);
    if (!found) throw new RangeError(`unknown commodity: ${commodity}`);
    return found;
  };
  const locate = (ownerId: string, commodity: string, location: StockLocation, ref?: string) =>
    stock.find(
      (item) =>
        item.ownerId === ownerId &&
        item.commodity === commodity &&
        item.location === location &&
        (location === 'reserved'
          ? item.reservationId === ref
          : location === 'transit'
            ? item.shipmentId === ref
            : true),
    );
  const changeStock = (
    ownerId: string,
    commodity: string,
    location: StockLocation,
    ref: string | undefined,
    delta: number,
  ) => {
    if (!state.owners.includes(ownerId)) throw new RangeError(`unknown owner: ${ownerId}`);
    stockDef(commodity);
    const found = locate(ownerId, commodity, location, ref);
    const next = checkedAdd(found?.quantity ?? 0, delta);
    if (next < 0) throw new RangeError('insufficient inventory');
    if (found) found.quantity = next;
    else if (next)
      stock.push({
        ownerId,
        commodity,
        location,
        quantity: next,
        ...(location === 'reserved' ? { reservationId: ref } : {}),
        ...(location === 'transit' ? { shipmentId: ref } : {}),
      });
  };
  const effects: unknown[] = [];
  for (const operation of safeOperations) {
    const stockBefore = stock.map((item) => ({ ...item }));
    id(operation.causeId, 'cause id');
    if (operation.type === 'payment') {
      positive(operation.amount, 'payment amount');
      const from = accounts.find((item) => item.id === operation.fromAccountId),
        to = accounts.find((item) => item.id === operation.toAccountId);
      if (!from || !to) throw new RangeError('unknown payment account');
      if (from.id === to.id) throw new RangeError('self-payment is not allowed');
      if (from.balance < operation.amount) throw new RangeError('insufficient funds');
      from.balance -= operation.amount;
      to.balance = checkedAdd(to.balance, operation.amount);
      effects.push({ debit: from.id, credit: to.id, amount: operation.amount });
    } else if (operation.type === 'reserve') {
      positive(operation.quantity, 'quantity');
      id(operation.reservationId, 'reservation id');
      if (
        stock.some((item) => item.reservationId === operation.reservationId) ||
        journal.some(
          (entry) =>
            entry.type === 'reserve' &&
            (entry.effects[0] as { reservationId?: string }).reservationId ===
              operation.reservationId,
        )
      )
        throw new RangeError('duplicate reservation');
      changeStock(
        operation.ownerId,
        operation.commodity,
        'available',
        undefined,
        -operation.quantity,
      );
      changeStock(
        operation.ownerId,
        operation.commodity,
        'reserved',
        operation.reservationId,
        operation.quantity,
      );
      effects.push({ reserve: operation.quantity, reservationId: operation.reservationId });
    } else if (operation.type === 'release' || operation.type === 'depart') {
      const held = stock
        .filter(
          (item) => item.location === 'reserved' && item.reservationId === operation.reservationId,
        )
        .map((item) => ({ ...item }));
      if (!held.length) throw new RangeError('unknown reservation');
      if (operation.type === 'depart') {
        id(operation.shipmentId, 'shipment id');
        if (
          stock.some((item) => item.shipmentId === operation.shipmentId) ||
          journal.some(
            (entry) =>
              entry.type === 'depart' &&
              (entry.effects[0] as { shipmentId?: string }).shipmentId === operation.shipmentId,
          )
        )
          throw new RangeError('shipment ID already used');
      }
      for (const item of held) {
        changeStock(
          item.ownerId,
          item.commodity,
          'reserved',
          operation.reservationId,
          -item.quantity,
        );
        if (operation.type === 'depart') {
          id(operation.shipmentId, 'shipment id');
          changeStock(item.ownerId, item.commodity, 'transit', operation.shipmentId, item.quantity);
        } else changeStock(item.ownerId, item.commodity, 'available', undefined, item.quantity);
      }
      effects.push({
        [operation.type]: operation.reservationId,
        ...(operation.type === 'depart' ? { shipmentId: operation.shipmentId } : {}),
        quantity: held.reduce((sum, item) => checkedAdd(sum, item.quantity), 0),
      });
    } else if (operation.type === 'arrive') {
      const cargo = stock
        .filter((item) => item.location === 'transit' && item.shipmentId === operation.shipmentId)
        .map((item) => ({ ...item }));
      if (!cargo.length) throw new RangeError('unknown shipment');
      id(operation.toOwnerId, 'destination owner');
      for (const item of cargo) {
        changeStock(item.ownerId, item.commodity, 'transit', operation.shipmentId, -item.quantity);
        changeStock(operation.toOwnerId, item.commodity, 'available', undefined, item.quantity);
      }
      effects.push({ arrive: operation.shipmentId, destination: operation.toOwnerId });
    } else if (operation.type === 'transfer' || operation.type === 'inventory-transfer') {
      positive(operation.quantity, 'quantity');
      const from = operation.type === 'transfer' ? operation.from : 'available';
      const to = operation.type === 'transfer' ? operation.to : 'available';
      if (from !== 'available' || to !== 'available')
        throw new RangeError('reserved stock must use a validated reservationId operation');
      if (operation.ownerId === operation.toOwnerId && from === to)
        throw new RangeError('same-location transfer is not allowed');
      changeStock(operation.ownerId, operation.commodity, from, undefined, -operation.quantity);
      changeStock(operation.toOwnerId, operation.commodity, to, undefined, operation.quantity);
      effects.push({
        from: operation.ownerId,
        to: operation.toOwnerId,
        commodity: operation.commodity,
        quantity: operation.quantity,
      });
    } else if (operation.type === 'consume' || operation.type === 'loss') {
      positive(operation.quantity, 'quantity');
      changeStock(
        operation.ownerId,
        operation.commodity,
        'available',
        undefined,
        -operation.quantity,
      );
      effects.push({
        [operation.type]: operation.quantity,
        ownerId: operation.ownerId,
        commodity: operation.commodity,
      });
    } else if (operation.type === 'conversion') {
      id(operation.recipeId, 'recipe id');
      const recipe = state.recipes.find((item) => item.id === operation.recipeId);
      if (!recipe) throw new RangeError('recipe is not declared in accounting config');
      if (
        JSON.stringify(operation.inputs) !== JSON.stringify(recipe.inputs) ||
        JSON.stringify(operation.outputs) !== JSON.stringify(recipe.outputs)
      )
        throw new RangeError('conversion does not match declared recipe');
      if (
        !Array.isArray(operation.inputs) ||
        !operation.inputs.length ||
        !Array.isArray(operation.outputs) ||
        !operation.outputs.length
      )
        throw new RangeError('recipe requires inputs and outputs');
      const recipeLines = (lines: readonly Line[]) => {
        const seen = new Set<string>();
        for (const line of lines) {
          positive(line.quantity, 'recipe quantity');
          stockDef(line.commodity);
          if (seen.has(line.commodity)) throw new RangeError('duplicate recipe line');
          seen.add(line.commodity);
        }
      };
      recipeLines(operation.inputs);
      recipeLines(operation.outputs);
      for (const line of operation.inputs)
        changeStock(operation.ownerId, line.commodity, 'available', undefined, -line.quantity);
      for (const line of operation.outputs)
        changeStock(operation.ownerId, line.commodity, 'available', undefined, line.quantity);
      effects.push({
        recipeId: operation.recipeId,
        inputs: operation.inputs,
        outputs: operation.outputs,
      });
    }
    const stockKeys = (item: AccountingStock) =>
      `${item.ownerId}\u0000${item.commodity}\u0000${item.location}\u0000${item.reservationId ?? item.shipmentId ?? ''}`;
    const stockDelta = new Map<
      string,
      { ownerId: string; commodity: string; location: StockLocation; ref?: string; delta: bigint }
    >();
    const allStock = new Map<string, AccountingStock>();
    for (const item of [...stockBefore, ...stock]) allStock.set(stockKeys(item), item);
    for (const [key, item] of allStock) {
      const before = stockBefore.find((prior) => stockKeys(prior) === key)?.quantity ?? 0;
      const after = stock.find((current) => stockKeys(current) === key)?.quantity ?? 0;
      stockDelta.set(key, {
        ownerId: item.ownerId,
        commodity: item.commodity,
        location: item.location,
        ...(item.reservationId
          ? { ref: item.reservationId }
          : item.shipmentId
            ? { ref: item.shipmentId }
            : {}),
        delta: BigInt(after) - BigInt(before),
      });
    }
    const journalEffect = effects[effects.length - 1] as Record<string, unknown>;
    journal.push({
      transactionId,
      causeId: operation.causeId,
      type: operation.type,
      effects: [
        {
          ...journalEffect,
          stockDeltas: [...stockDelta.values()]
            .filter((item) => item.delta !== 0n)
            .map((item) => ({ ...item, delta: Number(item.delta) })),
        },
      ],
      rationale:
        operation.type === 'loss'
          ? (operation.rationale ?? 'declared loss')
          : operation.type === 'conversion'
            ? `recipe:${operation.recipeId}`
            : operation.type,
    });
  }
  const next: AccountingState = {
    version: 1,
    currency: { ...state.currency },
    commodities: state.commodities.map((commodity) => ({ ...commodity })),
    owners: [...state.owners],
    accounts,
    stock: stock.filter((item) => item.quantity > 0),
    journal,
    openingBalances: state.openingBalances.map((item) => ({ ...item })),
    openingStock: state.openingStock.map((item) => ({ ...item })),
    recipes: state.recipes.map((recipe) => structuredClone(recipe)),
  };
  assertAccountingInvariant(next);
  return next;
}

export interface AccountingEngine {
  registerCommandHandler(
    type: string,
    handler: (draft: Record<string, unknown>, payload: unknown) => void,
  ): void;
  registerInvariant(invariant: (domain: Readonly<Record<string, unknown>>) => void): void;
}
export function registerAccounting(engine: AccountingEngine): void {
  engine.registerInvariant((domain) => {
    if (domain.accounting !== undefined)
      assertAccountingInvariant(domain.accounting as AccountingState);
  });
  engine.registerCommandHandler('accounting.transaction', (draft, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('invalid accounting command');
    const command = payload as { operations?: AccountingOperation[]; causeId?: string };
    if (
      !draft.accounting ||
      !Array.isArray(command.operations) ||
      typeof command.causeId !== 'string'
    )
      throw new TypeError('invalid accounting command');
    try {
      draft.accounting = applyAccountingTransaction(
        draft.accounting as AccountingState,
        command.operations,
        command.causeId,
      );
    } catch {
      throw new DomainCommandRejection();
    }
  });
}
