import { registerTransactionParticipant } from './transaction-internal.js';

/** Provisional integer accounting only; this does not claim a fiat scale or real-world currency. */
export interface MoneyBalanceInput {
  readonly accountId: string;
  readonly amount: number;
}

export interface MoneyLedgerInput {
  readonly accounts: readonly string[];
  readonly balances?: readonly MoneyBalanceInput[];
}

export interface MoneySnapshot {
  readonly balances: readonly MoneyBalanceInput[];
}

export interface MoneyLedger {
  getState(): MoneySnapshot;
  transfer(fromAccountId: string, toAccountId: string, amount: number): MoneySnapshot;
}

export function createMoneyLedger(input: MoneyLedgerInput): MoneyLedger {
  const accounts = [...input.accounts];
  const accountIds = new Set<string>();
  let balances = new Map<string, number>();
  const validateAccountId = (accountId: string): void => {
    if (typeof accountId !== 'string') throw new TypeError('account id must be a string');
    if (accountId.length === 0) throw new RangeError('account id must be nonempty');
  };
  const validateBalance = (amount: number): void => {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) {
      throw new TypeError('balance must be a finite integer');
    }
    if (amount < 0 || !Number.isSafeInteger(amount)) {
      throw new RangeError('balance must be a nonnegative safe integer');
    }
  };

  for (const accountId of accounts) {
    validateAccountId(accountId);
    if (accountIds.has(accountId)) throw new RangeError(`duplicate account: ${accountId}`);
    accountIds.add(accountId);
    balances.set(accountId, 0);
  }
  const initialized = new Set<string>();
  for (const balance of input.balances ?? []) {
    validateAccountId(balance.accountId);
    if (!accountIds.has(balance.accountId))
      throw new RangeError(`unknown account: ${balance.accountId}`);
    validateBalance(balance.amount);
    if (initialized.has(balance.accountId)) {
      throw new RangeError(`duplicate opening balance: ${balance.accountId}`);
    }
    initialized.add(balance.accountId);
    balances.set(balance.accountId, balance.amount);
  }

  const snapshot = (): MoneySnapshot => ({
    balances: accounts.map((accountId) => ({ accountId, amount: balances.get(accountId)! })),
  });
  const api: MoneyLedger = {
    getState: snapshot,
    transfer: (fromAccountId, toAccountId, amount) => {
      if (!accountIds.has(fromAccountId)) {
        throw new RangeError(`unknown source account: ${fromAccountId}`);
      }
      if (!accountIds.has(toAccountId)) {
        throw new RangeError(`unknown destination account: ${toAccountId}`);
      }
      if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) {
        throw new TypeError('transfer amount must be a finite integer');
      }
      if (amount <= 0 || !Number.isSafeInteger(amount)) {
        throw new RangeError('transfer amount must be a positive safe integer');
      }
      if (fromAccountId === toAccountId) return snapshot();
      const source = balances.get(fromAccountId)!;
      const destination = balances.get(toAccountId)!;
      if (source < amount) throw new RangeError('insufficient funds');
      if (amount > Number.MAX_SAFE_INTEGER - destination) {
        throw new RangeError('destination balance would exceed Number.MAX_SAFE_INTEGER');
      }
      balances.set(fromAccountId, source - amount);
      balances.set(toAccountId, destination + amount);
      return snapshot();
    },
  };
  registerTransactionParticipant(api, {
    money: {
      prepareTransfer: (fromAccountId, toAccountId, amount) => {
        if (!accountIds.has(fromAccountId)) {
          throw new RangeError(`unknown source account: ${fromAccountId}`);
        }
        if (!accountIds.has(toAccountId)) {
          throw new RangeError(`unknown destination account: ${toAccountId}`);
        }
        if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) {
          throw new TypeError('transfer amount must be a finite integer');
        }
        if (amount <= 0 || !Number.isSafeInteger(amount)) {
          throw new RangeError('transfer amount must be a positive safe integer');
        }
        const source = balances.get(fromAccountId)!;
        const destination = balances.get(toAccountId)!;
        if (source < amount) throw new RangeError('insufficient funds');
        if (amount > Number.MAX_SAFE_INTEGER - destination) {
          throw new RangeError('destination balance would exceed Number.MAX_SAFE_INTEGER');
        }
        if (fromAccountId === toAccountId) return () => {};
        const stagedBalances = new Map(balances);
        stagedBalances.set(fromAccountId, source - amount);
        stagedBalances.set(toAccountId, destination + amount);
        return () => {
          balances = stagedBalances;
        };
      },
    },
  });
  return api;
}
