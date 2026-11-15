import { describe, expect, it } from 'vitest';
import {
  applyAccountingTransaction,
  createAccountingState,
} from '../../packages/simulation-core/src/services/accounting/index.js';
import { createEngine } from '../../packages/simulation-core/src/services/engine.js';
import {
  applyScheduledTransfer,
  registerGovernment,
  scheduleFundedTransfer,
  type GovernmentKingdom,
  assessGovernmentTax,
  decideInstitutionalPolicy,
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
  it('charges an eligible payer into the treasury once for a taxable event', () => {
    const fundedPayer = applyAccountingTransaction(
      initial(),
      [
        {
          type: 'payment',
          fromAccountId: 'treasury-n',
          toAccountId: 'households-n',
          amount: { kind: 'money', currencyId: 'coin', unit: 'coin', scale: 0, minor: 5 },
          causeId: 'seed-payer',
        },
      ],
      'seed-payer',
    );
    const charged = assessGovernmentTax(fundedPayer, {
      policyId: 'levy',
      payerAccountId: 'households-n',
      treasuryAccountId: 'treasury-n',
      amount: 3,
      taxableEventId: 'sale-1',
      tick: 2,
    });
    expect(charged.accounts.map((account) => account.balance)).toEqual([8, 2, 0]);
    expect(charged.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'payment', causeId: 'government:levy:event:sale-1' }),
      ]),
    );
    expect(
      assessGovernmentTax(charged, {
        policyId: 'levy',
        payerAccountId: 'households-n',
        treasuryAccountId: 'treasury-n',
        amount: 3,
        taxableEventId: 'sale-1',
        tick: 2,
      }),
    ).toBe(charged);
  });
  it('does not treat caller-asserted jurisdiction as tax authorization', () => {
    const state = createAccountingState({
      currency: { id: 'coin', unit: 'coin', scale: 0 },
      commodities: [],
      owners: ['north', 'firm-1'],
      accounts: [
        { id: 'treasury-n', ownerId: 'north', openingBalance: 0 },
        { id: 'firm-cash', ownerId: 'firm-1', openingBalance: 5 },
      ],
    });
    expect(() =>
      assessGovernmentTax(state, {
        policyId: 'levy',
        payerAccountId: 'firm-cash',
        treasuryAccountId: 'treasury-n',
        amount: 2,
        taxableEventId: 'firm-sale',
        tick: 1,
      }),
    ).toThrow(/one jurisdiction/i);
    expect(state.accounts.map((account) => account.balance)).toEqual([0, 5]);
  });
  it('rejects an unfunded tax atomically without changing the ledger', () => {
    const state = initial();
    expect(() =>
      assessGovernmentTax(state, {
        policyId: 'levy',
        payerAccountId: 'households-n',
        treasuryAccountId: 'treasury-n',
        amount: 1,
        taxableEventId: 'sale-empty',
        tick: 1,
      }),
    ).toThrow();
    expect(state.accounts.map((account) => account.balance)).toEqual([10, 0, 0]);
    expect(state.journal).toEqual([]);
  });
  it('enforces institutional veto and delay at the player command boundary', () => {
    const engine = createEngine({ initialState: { accounting: initial() } }, 1);
    registerGovernment(engine, {
      kingdoms: [{ ...kingdoms[0]!, recipients: kingdoms[0]!.recipients }, kingdoms[1]!],
      institutions: { north: 'parliamentary' },
    });
    const payload = {
      kingdomId: 'north',
      governmentId: 'north',
      policyId: 'delayed-grant',
      recipientKingdomId: 'north',
      recipientOwnerId: 'north',
      recipientAccountId: 'households-n',
      amount: 1,
      effectiveTick: 2,
      expiryTick: 8,
      legitimacy: 80,
      quorum: 70,
      support: 70,
      oppositionVeto: false,
    };
    engine.submit({
      commandId: 'approved-grant',
      type: 'government.policy',
      requestedTick: 1,
      payload,
    });
    engine.step();
    expect(engine.getState().domain.government).toMatchObject({
      policies: [expect.objectContaining({ policyId: 'delayed-grant', effectiveTick: 4 })],
    });
  });
  it('uses differentiated transparent institutional authority rules', () => {
    const outcomes = (
      ['city-council', 'monarchy', 'parliamentary', 'central-republic'] as const
    ).map((institution) =>
      decideInstitutionalPolicy({
        institution,
        legitimacy: 60,
        quorum: 60,
        support: 60,
        oppositionVeto: true,
      }),
    );
    expect(new Set(outcomes.map((outcome) => outcome.effectiveDelay)).size).toBeGreaterThan(1);
    expect(new Set(outcomes.map((outcome) => outcome.approved)).size).toBeGreaterThan(1);
    expect(outcomes.every((outcome) => outcome.reason && outcome.alternatives.length > 0)).toBe(
      true,
    );
  });
});
