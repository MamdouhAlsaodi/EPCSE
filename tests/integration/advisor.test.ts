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
function setup() {
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
  const engine = createEngine({ initialState: { accounting } }, 23);
  registerGovernment(engine, { kingdoms, cityKingdomIds: { capital: 'player' } });
  registerAdvisor(engine, { kingdoms, cityKingdomIds: { capital: 'player' } });
  return engine;
}
const grant = {
  grantId: 'grant-1',
  kingdomId: 'player',
  advisorId: 'advisor-1',
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
};
const aid = {
  kingdomId: 'player',
  governmentId: 'player',
  variant: 'transfer',
  policyId: 'advisor-aid',
  recipientKingdomId: 'player',
  recipientOwnerId: 'player',
  recipientAccountId: 'recipient-player',
  amount: 4,
  effectiveTick: 3,
  expiryTick: 3,
};
const asAdvisor = (commandId: string, requestedTick: number, payload: unknown) => ({
  commandId,
  type: 'government.policy',
  requestedTick,
  actor: { kind: 'advisor' as const, id: 'advisor-1' },
  payload,
});

describe('advisor delegation integration', () => {
  it('rejects advisor policies when only an unrelated generic validator is registered', () => {
    const engine = createEngine({ initialState: {} }, 23);
    registerGovernment(engine, { kingdoms, cityKingdomIds: { capital: 'player' } });
    engine.registerCommandSubmitValidator(() => undefined);

    const receipt = engine.submit(
      asAdvisor('unregistered-advisor-policy', 1, {
        ...aid,
        effectiveTick: 1,
        expiryTick: 1,
      }),
    );

    expect(receipt).toMatchObject({ status: 'rejected', errorCode: 'UNAUTHORIZED' });
    engine.step();
    expect(engine.getState().domain.government).toMatchObject({ policies: [] });
  });

  it('executes a command accepted before revocation and rejects later attempts', () => {
    const engine = setup();
    engine.submit({
      commandId: 'grant',
      type: 'advisor.grant',
      requestedTick: 2,
      actor: { kind: 'player', id: 'player' },
      payload: grant,
    });
    engine.run(2);
    const accepted = asAdvisor('accepted-before-revoke', 4, {
      ...aid,
      effectiveTick: 4,
      expiryTick: 4,
    });
    expect(engine.submit(accepted).status).toBe('queued');
    engine.submit({
      commandId: 'revoke',
      type: 'advisor.revoke',
      requestedTick: 3,
      actor: { kind: 'player', id: 'player' },
      payload: { grantId: 'grant-1', kingdomId: 'player' },
    });
    engine.step();
    const afterRevoke = asAdvisor('rejected-after-revoke', 4, {
      ...aid,
      effectiveTick: 4,
      expiryTick: 4,
      policyId: 'later-aid',
    });
    expect(engine.submit(afterRevoke)).toMatchObject({
      status: 'rejected',
      errorCode: 'UNAUTHORIZED',
      sequence: null,
    });
    engine.step();
    expect(engine.getState().domain.accounting).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: 'treasury-player', balance: 16 }),
        expect.objectContaining({ id: 'recipient-player', balance: 4 }),
      ]),
    });
    expect(engine.receipts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandId: 'accepted-before-revoke', status: 'applied' }),
        expect.objectContaining({
          commandId: 'rejected-after-revoke',
          status: 'rejected',
          errorCode: 'UNAUTHORIZED',
        }),
      ]),
    );
    expect(engine.getState().domain.advisor).toMatchObject({
      audit: expect.arrayContaining([
        expect.objectContaining({ grantId: 'grant-1', action: 'grant' }),
        expect.objectContaining({ grantId: 'grant-1', action: 'revoke' }),
        expect.objectContaining({
          commandId: 'accepted-before-revoke',
          grantId: 'grant-1',
          tick: 2,
          outcome: 'authorized',
        }),
        expect.objectContaining({ commandId: 'rejected-after-revoke', outcome: 'rejected' }),
      ]),
    });
    expect(engine.getState().domain.government).toMatchObject({
      policies: [expect.objectContaining({ policyId: 'advisor-aid' })],
    });
  });

  it('rejects out-of-scope, over-bound, and AI-kingdom commands without queueing', () => {
    const engine = setup();
    engine.submit({
      commandId: 'grant',
      type: 'advisor.grant',
      requestedTick: 2,
      actor: { kind: 'player', id: 'player' },
      payload: grant,
    });
    engine.run(2);
    for (const [commandId, payload] of [
      [
        'wrong-recipient',
        {
          ...aid,
          recipientAccountId: 'recipient-ai',
          recipientOwnerId: 'ai',
          recipientKingdomId: 'ai',
        },
      ],
      ['over-limit', { ...aid, amount: 6 }],
      ['ai-kingdom', { ...aid, governmentId: 'ai', kingdomId: 'ai', policyId: 'ai-aid' }],
    ] as const) {
      expect(engine.submit(asAdvisor(commandId, 3, payload))).toMatchObject({
        status: 'rejected',
        errorCode: 'UNAUTHORIZED',
        sequence: null,
      });
    }
    expect(engine.snapshot().nextSequence).toBe(2);
    expect(engine.snapshot().queue).toHaveLength(0);
  });

  it('allows route-bounded capital investment grants without wildcard scope', () => {
    const engine = setup();
    engine.submit({
      commandId: 'route-grant',
      type: 'advisor.grant',
      requestedTick: 1,
      actor: { kind: 'player', id: 'player' },
      payload: {
        grantId: 'route-grant',
        kingdomId: 'player',
        advisorId: 'advisor-1',
        permissions: [
          { variant: 'capital-investment', scope: { routeId: 'road-1' }, maxAmount: 100 },
        ],
      },
    });
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'route-grant')).toMatchObject({
      status: 'applied',
    });
    expect(
      (engine.getState().domain.advisor as { grants: Array<{ permissions: unknown[] }> }).grants[0]
        ?.permissions,
    ).toHaveLength(1);
  });

  it('grants city-scoped tax only for the configured player city', () => {
    const engine = setup();
    const taxGrant = {
      grantId: 'tax-grant',
      kingdomId: 'player',
      advisorId: 'advisor-1',
      permissions: [
        { variant: 'local-purchase-tax', scope: { cityId: 'capital' }, maxRateBps: 500 },
      ],
    };
    engine.submit({
      commandId: 'tax-grant',
      type: 'advisor.grant',
      requestedTick: 1,
      actor: { kind: 'player', id: 'player' },
      payload: taxGrant,
    });
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'tax-grant')).toMatchObject({
      status: 'applied',
    });
    const taxCommand = asAdvisor('city-tax', 2, {
      kingdomId: 'player',
      governmentId: 'player',
      variant: 'local-purchase-tax',
      policyId: 'city-tax-policy',
      cityId: 'capital',
      rateBps: 400,
      incidence: 'buyer',
      effectiveTick: 2,
      expiryTick: 2,
    });
    expect(engine.submit(taxCommand).status).toBe('queued');
    engine.step();
    expect(engine.receipts().find((receipt) => receipt.commandId === 'city-tax')?.status).toBe(
      'applied',
    );
    expect(engine.getState().domain.government).toMatchObject({
      taxPolicies: [expect.objectContaining({ policyId: 'city-tax-policy', cityId: 'capital' })],
    });
  });

  it.each([
    [
      'food-subsidy',
      {
        recipientKingdomId: 'player',
        recipientOwnerId: 'player',
        recipientAccountId: 'recipient-player',
        commodity: 'grain',
      },
      5,
      {
        recipientKingdomId: 'player',
        recipientOwnerId: 'player',
        recipientAccountId: 'recipient-player',
        commodity: 'grain',
        amount: 4,
      },
    ],
    [
      'import-tariff',
      { importKingdomId: 'player', routeId: 'road-1', commodity: 'grain' },
      10,
      { importKingdomId: 'player', routeId: 'road-1', commodity: 'grain', amount: 4 },
    ],
    [
      'trade-restriction',
      { importKingdomId: 'player', routeId: 'road-1', commodity: 'grain' },
      undefined,
      { importKingdomId: 'player', routeId: 'road-1', commodity: 'grain' },
    ],
    ['capital-investment', { cityId: 'capital' }, 10, { targetCityId: 'capital', cost: 4 }],
  ] as const)('authorizes the exact %s scope and bound', (variant, scope, maxAmount, fields) => {
    const engine = setup();
    engine.submit({
      commandId: `grant-${variant}`,
      type: 'advisor.grant',
      requestedTick: 1,
      actor: { kind: 'player', id: 'player' },
      payload: {
        grantId: `grant-${variant}`,
        kingdomId: 'player',
        advisorId: 'advisor-1',
        permissions: [{ variant, scope, ...(maxAmount === undefined ? {} : { maxAmount }) }],
      },
    });
    engine.step();
    const payload = {
      kingdomId: 'player',
      governmentId: 'player',
      variant,
      policyId: `policy-${variant}`,
      ...fields,
      effectiveTick: 2,
      expiryTick: 2,
    };
    expect(engine.submit(asAdvisor(`command-${variant}`, 2, payload)).status).toBe('queued');
  });

  it('restores queued grants and policies and rejects a tampered grant snapshot atomically', () => {
    const engine = setup();
    engine.submit({
      commandId: 'grant',
      type: 'advisor.grant',
      requestedTick: 2,
      actor: { kind: 'player', id: 'player' },
      payload: grant,
    });
    const restored = setup();
    restored.restore(engine.snapshot());
    engine.run(2);
    restored.run(2);
    const policy = asAdvisor('aid', 4, { ...aid, effectiveTick: 4, expiryTick: 4 });
    expect(engine.submit(policy)).toEqual(restored.submit(policy));
    const before = engine.snapshotText();
    const tampered = engine.snapshot();
    (
      tampered.domain.advisor as {
        grants: Array<{ permissions: Array<{ scope: Record<string, string> }> }>;
      }
    ).grants[0]!.permissions[0]!.scope.recipientAccountId = '*';
    expect(() => engine.restore(tampered)).toThrow();
    expect(engine.snapshotText()).toBe(before);
  });
});
