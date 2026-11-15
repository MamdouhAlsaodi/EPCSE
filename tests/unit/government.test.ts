import { describe, expect, it } from 'vitest';
import { createAccountingState } from '../../packages/simulation-core/src/services/accounting/index.js';
import { createEngine } from '../../packages/simulation-core/src/services/engine.js';
import {
  applyScheduledTransfer,
  registerGovernment,
  scheduleFundedTransfer,
  type GovernmentKingdom,
} from '../../packages/simulation-core/src/services/government/index.js';
const kingdoms: GovernmentKingdom[] = [
  {
    kingdomId: 'north',
    controller: 'player',
    treasuryAccountId: 'treasury-n',
    recipients: [{ kingdomId: 'north', ownerId: 'north', accountId: 'households-n' }],
  },
  {
    kingdomId: 'south',
    controller: 'ai',
    treasuryAccountId: 'households-s',
    recipients: [{ kingdomId: 'south', ownerId: 'south', accountId: 'households-s' }],
  },
];
const initial = () =>
  createAccountingState({
    currency: { id: 'coin', unit: 'coin', scale: 0 },
    commodities: [],
    owners: ['north', 'south'],
    accounts: [
      { id: 'treasury-n', ownerId: 'north', openingBalance: 10 },
      { id: 'households-n', ownerId: 'north', openingBalance: 0 },
      { id: 'households-s', ownerId: 'south', openingBalance: 0 },
    ],
  });
describe('funded government transfers', () => {
  it('rejects configurations with more than one player kingdom', () => {
    expect(() =>
      registerGovernment(createEngine({ initialState: {} }, 1), {
        kingdoms: [
          { ...kingdoms[0]!, controller: 'player' },
          { ...kingdoms[1]!, controller: 'player' },
        ],
      }),
    ).toThrow();
  });
  it('rejects an AI policy whose recipient is its treasury', () => {
    expect(() =>
      registerGovernment(createEngine({ initialState: {} }, 1), {
        kingdoms: [
          kingdoms[0]!,
          {
            ...kingdoms[1]!,
            aiPolicy: {
              recipientOwnerId: 'south',
              recipientAccountId: 'households-s',
              amount: 1,
              reserve: 0,
            },
          },
        ],
      }),
    ).toThrow();
  });
  it('debits the configured treasury and credits a mapped real recipient only when due', () => {
    const policy = scheduleFundedTransfer(
      {
        policyId: 'aid',
        governmentId: 'north',
        recipientKingdomId: 'north',
        recipientOwnerId: 'north',
        recipientAccountId: 'households-n',
        amount: 4,
        effectiveTick: 2,
        expiryTick: 3,
      },
      kingdoms,
      initial().accounts,
    );
    const state = initial();
    expect(applyScheduledTransfer(state, policy, 1, 'treasury-n')).toEqual(state);
    const paid = applyScheduledTransfer(state, policy, 2, 'treasury-n');
    expect(paid.accounts.map((x) => x.balance)).toEqual([6, 4, 0]);
    expect(paid.journal[0]).toMatchObject({ type: 'payment', causeId: 'government:aid' });
    expect(applyScheduledTransfer(paid, policy, 4, 'treasury-n')).toEqual(paid);
  });
  it('rejects recipients outside the funding kingdom and mismatched treasury ownership', () => {
    expect(() =>
      scheduleFundedTransfer(
        {
          policyId: 'cross-kingdom',
          governmentId: 'north',
          recipientKingdomId: 'south',
          recipientOwnerId: 'south',
          recipientAccountId: 'households-s',
          amount: 1,
          effectiveTick: 1,
          expiryTick: 2,
        },
        kingdoms,
        initial().accounts,
      ),
    ).toThrow();
    expect(() =>
      scheduleFundedTransfer(
        {
          policyId: 'x',
          governmentId: 'north',
          recipientKingdomId: 'south',
          recipientOwnerId: 'south',
          recipientAccountId: 'fake',
          amount: 1,
          effectiveTick: 1,
          expiryTick: 2,
        },
        kingdoms,
        [],
      ),
    ).toThrow();
    expect(
      applyScheduledTransfer(
        initial(),
        {
          policyId: 'aid',
          governmentId: 'north',
          recipientKingdomId: 'south',
          recipientOwnerId: 'south',
          recipientAccountId: 'households-s',
          amount: 1,
          effectiveTick: 1,
          expiryTick: 2,
        },
        1,
        'households-s',
      ),
    ).toEqual(initial());
  });
});
