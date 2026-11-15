import { describe, expect, it } from 'vitest';
import { createEngine } from '../../packages/simulation-core/src/services/engine.js';
import { registerAdvisor } from '../../packages/simulation-core/src/services/advisor/index.js';
import { registerGovernment } from '../../packages/simulation-core/src/services/government/index.js';
import { createAccountingState } from '../../packages/simulation-core/src/services/accounting/index.js';

const kingdoms = [
  {
    kingdomId: 'player',
    controller: 'player' as const,
    treasuryAccountId: 'treasury-player',
    recipients: [{ kingdomId: 'player', ownerId: 'player', accountId: 'recipient-player' }],
  },
  {
    kingdomId: 'ai',
    controller: 'ai' as const,
    treasuryAccountId: 'treasury-ai',
    recipients: [{ kingdomId: 'ai', ownerId: 'ai', accountId: 'recipient-ai' }],
  },
];
const accounting = createAccountingState({
  currency: { id: 'coin', unit: 'coin', scale: 0 },
  commodities: [],
  owners: ['player', 'ai'],
  accounts: [
    { id: 'treasury-player', ownerId: 'player', openingBalance: 20 },
    { id: 'recipient-player', ownerId: 'player', openingBalance: 0 },
    { id: 'treasury-ai', ownerId: 'ai', openingBalance: 20 },
    { id: 'recipient-ai', ownerId: 'ai', openingBalance: 0 },
  ],
});
function setup() {
  const engine = createEngine({ initialState: { accounting } }, 11);
  registerGovernment(engine, { kingdoms });
  registerAdvisor(engine, { kingdoms });
  return engine;
}

describe('advisor delegation', () => {
  it('fails closed for advisor actors when advisor handlers are not registered', () => {
    const engine = createEngine({ initialState: { accounting } }, 11);
    registerGovernment(engine, { kingdoms });
    const receipt = engine.submit({
      commandId: 'unregistered-advisor',
      type: 'government.policy',
      requestedTick: 1,
      actor: { kind: 'advisor', id: 'counsellor' },
      payload: {
        kingdomId: 'player',
        governmentId: 'player',
        policyId: 'aid',
        recipientKingdomId: 'player',
        recipientOwnerId: 'player',
        recipientAccountId: 'recipient-player',
        amount: 2,
        effectiveTick: 1,
        expiryTick: 1,
      },
    });
    expect(receipt).toMatchObject({
      status: 'rejected',
      errorCode: 'UNAUTHORIZED',
      sequence: null,
    });
    engine.step();
    expect(engine.getState().domain.government).toMatchObject({ policies: [] });
  });

  it('keeps rejection auditing transactional when an audit hook throws', () => {
    const engine = createEngine({ initialState: { marker: 'stable' } }, 11);
    engine.registerCommandSubmitValidator(() => 'UNAUTHORIZED');
    engine.registerSubmitRejectionAudit((draft) => {
      draft.marker = 'corrupted';
      throw new Error('audit failed');
    });
    const result = engine.submit({
      commandId: 'audit-failure',
      type: 'government.policy',
      requestedTick: 1,
      payload: {},
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'INVALID', sequence: null });
    expect(engine.getState().domain.marker).toBe('stable');
    expect(engine.snapshot().nextSequence).toBe(1);
    expect(engine.receipts()).toEqual([]);
  });

  it('rejects unsupported advisor commands and malformed actor envelopes', () => {
    const engine = setup();
    expect(
      engine.submit({
        commandId: 'advisor-diplomacy',
        type: 'diplomacy.decision',
        requestedTick: 1,
        actor: { kind: 'advisor', id: 'counsellor' },
        payload: {},
      }),
    ).toMatchObject({ status: 'rejected', errorCode: 'UNAUTHORIZED' });
    expect(
      engine.submit({
        commandId: 'malformed-actor',
        type: 'government.policy',
        requestedTick: 1,
        actor: { kind: 'player', id: 'player', extra: true } as never,
        payload: {},
      }),
    ).toMatchObject({ status: 'rejected', errorCode: 'INVALID' });
    expect(engine.snapshot().nextSequence).toBe(1);
  });

  it('requires player provenance for grant and revoke commands', () => {
    const engine = setup();
    const result = engine.submit({
      commandId: 'advisor-self-grant',
      type: 'advisor.grant',
      requestedTick: 1,
      actor: { kind: 'advisor', id: 'counsellor' },
      payload: {
        grantId: 'self',
        kingdomId: 'player',
        advisorId: 'counsellor',
        permissions: [
          {
            variant: 'transfer',
            scope: {
              recipientKingdomId: 'player',
              recipientOwnerId: 'player',
              recipientAccountId: 'recipient-player',
            },
            maxAmount: 5,
          },
        ],
      },
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'UNAUTHORIZED', sequence: null });
    engine.step();
    expect(engine.getState().domain.advisor).toBeUndefined();
  });

  it('rejects and audits an advisor policy at submit without consuming sequence', () => {
    const engine = setup();
    const receipt = engine.submit({
      commandId: 'unauthorized-policy',
      type: 'government.policy',
      requestedTick: 1,
      actor: { kind: 'advisor', id: 'counsellor' },
      payload: {
        kingdomId: 'player',
        governmentId: 'player',
        policyId: 'aid',
        recipientKingdomId: 'player',
        recipientOwnerId: 'player',
        recipientAccountId: 'recipient-player',
        amount: 2,
        effectiveTick: 1,
        expiryTick: 1,
      },
    });
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      status: 'rejected',
      errorCode: 'UNAUTHORIZED',
      sequence: null,
    });
    expect(engine.snapshot().nextSequence).toBe(1);
    const restored = setup();
    restored.restore(engine.snapshot());
    expect(
      restored.submit({
        commandId: 'unauthorized-policy',
        type: 'government.policy',
        requestedTick: 1,
        actor: { kind: 'advisor', id: 'counsellor' },
        payload: {
          kingdomId: 'player',
          governmentId: 'player',
          policyId: 'aid',
          recipientKingdomId: 'player',
          recipientOwnerId: 'player',
          recipientAccountId: 'recipient-player',
          amount: 2,
          effectiveTick: 1,
          expiryTick: 1,
        },
      }),
    ).toEqual(receipt);
    expect(
      engine.submit({
        commandId: 'unauthorized-policy',
        type: 'government.policy',
        requestedTick: 1,
        actor: { kind: 'advisor', id: 'counsellor' },
        payload: {
          kingdomId: 'player',
          governmentId: 'player',
          policyId: 'aid',
          recipientKingdomId: 'player',
          recipientOwnerId: 'player',
          recipientAccountId: 'recipient-player',
          amount: 2,
          effectiveTick: 1,
          expiryTick: 1,
        },
      }),
    ).toEqual(receipt);
    engine.step();
    expect(engine.getState().domain.advisor).toMatchObject({
      audit: [expect.objectContaining({ commandId: 'unauthorized-policy', outcome: 'rejected' })],
    });
    expect(engine.receipts()).toContainEqual(receipt);
  });
});
