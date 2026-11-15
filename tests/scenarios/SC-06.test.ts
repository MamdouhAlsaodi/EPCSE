import { describe, expect, it } from 'vitest';
import {
  createAccountingState,
  createEngine,
  registerPolitics,
} from '../../packages/simulation-core/src/index.js';

describe('SC-06 social settlement', () => {
  const setup = (acceptance = 10000, balance = 20) => {
    const accounting = createAccountingState({
      currency: { id: 'coin', unit: 'cent', scale: 0 },
      commodities: [],
      owners: ['firm', 'workers'],
      accounts: [
        { id: 'firm-cash', ownerId: 'firm', openingBalance: balance },
        { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
      ],
    });
    const engine = createEngine({ initialState: { accounting } }, 4);
    registerPolitics(engine, {
      groups: [
        {
          id: 'workers',
          producerIds: ['mill'],
          cohortId: 'cohort',
          organization: 80,
          resources: 20,
          realWageBps: 7000,
          unemploymentBps: 2000,
          satisfaction: 20,
          demand: { wageIncreaseBps: 500 },
          participationBps: 5000,
          recoveryTicks: 2,
          durationTicks: 5,
          employerAcceptanceBps: acceptance,
          employerAccountId: 'firm-cash',
          workerAccountId: 'worker-cash',
          employerOwnerId: 'firm',
          workerOwnerId: 'workers',
        },
      ],
      producers: [{ id: 'mill' }],
    });
    engine.step();
    engine.step();
    return engine;
  };
  it('fails a valid affordable-offer refusal; malformed offer is atomically rejected', () => {
    const engine = setup(0);
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'bad',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 1, wageIncreaseBps: 501 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'bad')?.status).toBe('rejected');
    engine.submit({
      commandId: 'refused',
      type: 'politics.negotiate',
      requestedTick: 4,
      payload: { actionId, decision: 'offer', amount: 1, wageIncreaseBps: 500 },
    });
    engine.step();
    expect(
      (engine.getState().domain.politics as { actions: Array<{ status: string }> }).actions[0]
        ?.status,
    ).toBe('negotiating');
    engine.step();
    expect(
      (engine.getState().domain.politics as { actions: Array<{ status: string }> }).actions[0]
        ?.status,
    ).toBe('failed');
  });
  it('settles funded concession and recovers capacity gradually', () => {
    const engine = setup();
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'funded',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 5, wageIncreaseBps: 500 },
    });
    engine.step();
    let domain = engine.getState().domain;
    expect((domain.politics as { actions: Array<{ status: string }> }).actions[0]?.status).toBe(
      'negotiating',
    );
    engine.step();
    domain = engine.getState().domain;
    expect((domain.politics as { actions: Array<{ status: string }> }).actions[0]?.status).toBe(
      'resolved',
    );
    expect(
      (domain.accounting as { accounts: Array<{ id: string; balance: number }> }).accounts.find(
        (a) => a.id === 'firm-cash',
      )?.balance,
    ).toBe(15);
    engine.step();
    domain = engine.getState().domain;
    expect(
      (domain.politics as { impactPlans: Record<string, { capacityBps: number }> }).impactPlans.mill
        ?.capacityBps,
    ).toBe(7500);
    engine.step();
    domain = engine.getState().domain;
    expect(
      (domain.politics as { impactPlans: Record<string, { capacityBps: number }> }).impactPlans.mill
        ?.capacityBps,
    ).toBe(10000);
  });
  it('resolves a negotiated offer and expires through negotiating after the duration limit', () => {
    const engine = setup();
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'counter',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 5, wageIncreaseBps: 500 },
    });
    engine.step();
    let politics = engine.getState().domain.politics as {
      actions: Array<{ status: string; transitionReasons: string[] }>;
      impactPlans: Record<string, { capacityBps: number }>;
    };
    expect(politics.actions[0]?.status).toBe('negotiating');
    engine.step();
    politics = engine.getState().domain.politics as {
      actions: Array<{ status: string; transitionReasons: string[] }>;
      impactPlans: Record<string, { capacityBps: number }>;
    };
    expect(politics.actions[0]?.status).toBe('resolved');
    const expiring = setup();
    expiring.run(6);
    politics = expiring.getState().domain.politics as {
      actions: Array<{ status: string; transitionReasons: string[] }>;
      impactPlans: Record<string, { capacityBps: number }>;
    };
    expect(politics.actions[0]?.status).toBe('expired');
    expect(politics.actions[0]?.transitionReasons).toContain('negotiating: duration limit reached');
    expect(politics.impactPlans.mill).toBeUndefined();
  });
  it('rejects a zero-payment positive concession without ledger effects', () => {
    const engine = setup();
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'free-concession',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 0, wageIncreaseBps: 500 },
    });
    const before = engine.getState().domain.accounting;
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'free-concession')?.status).toBe(
      'rejected',
    );
    expect(engine.getState().domain.accounting).toEqual(before);
  });
  it('rejects a tampered resolved snapshot and preserves current engine state', () => {
    const engine = setup();
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'funded-tamper',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 5, wageIncreaseBps: 500 },
    });
    engine.step();
    engine.step();
    const before = engine.snapshotText();
    const tampered = engine.snapshot();
    const domain = tampered.domain as {
      accounting: { journal: unknown[] };
      politics: { actions: Array<{ id: string; status: string }> };
    };
    domain.accounting.journal = [];
    expect(() => engine.restore(tampered)).toThrow();
    expect(engine.snapshotText()).toBe(before);
  });
  it('does not allow repeated offers to postpone a pending employer decision', () => {
    const engine = setup();
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'first-offer',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 5, wageIncreaseBps: 500 },
    });
    engine.step();
    engine.submit({
      commandId: 'repeat-offer',
      type: 'politics.negotiate',
      requestedTick: 4,
      payload: { actionId, decision: 'offer', amount: 6, wageIncreaseBps: 500 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'repeat-offer')?.status).toBe('rejected');
    const domain = engine.getState().domain;
    expect(
      (domain.politics as { actions: Array<{ status: string; settlementAmount: number }> })
        .actions[0],
    ).toMatchObject({ status: 'resolved', settlementAmount: 5 });
  });
  it('logs inability to fund as failed instead of resolving or rejecting', () => {
    const engine = setup(10000, 2);
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    const beforeAccounting = engine.getState().domain.accounting;
    engine.submit({
      commandId: 'unfunded',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 5, wageIncreaseBps: 500 },
    });
    engine.step();
    expect(engine.receipts().find((r) => r.commandId === 'unfunded')?.status).toBe('applied');
    expect(
      (engine.getState().domain.politics as { actions: Array<{ status: string }> }).actions[0]
        ?.status,
    ).toBe('negotiating');
    engine.step();
    expect(
      (engine.getState().domain.politics as { actions: Array<{ status: string; reason: string }> })
        .actions[0],
    ).toMatchObject({ status: 'failed', reason: 'settlement could not be funded' });
    expect(engine.getState().domain.accounting).toEqual(beforeAccounting);
  });
});
