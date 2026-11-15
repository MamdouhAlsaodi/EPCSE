import { describe, expect, it } from 'vitest';
import { createEngine, registerPolitics } from '../../packages/simulation-core/src/index.js';

describe('social action', () => {
  it('keeps a proposal observable for one tick before activation', () => {
    const engine = createEngine({ initialState: {} }, 1);
    registerPolitics(engine, {
      groups: [
        {
          id: 'miners',
          producerIds: ['mine'],
          cohortId: 'workers',
          organization: 80,
          resources: 20,
          realWageBps: 7000,
          unemploymentBps: 2000,
          satisfaction: 20,
          demand: { wageIncreaseBps: 1000 },
          participationBps: 8000,
          recoveryTicks: 3,
          durationTicks: 5,
        },
      ],
      producers: [{ id: 'mine' }],
    });
    engine.step();
    let politics = engine.getState().domain.politics as { actions: Array<{ status: string }> };
    expect(politics.actions[0]?.status).toBe('proposed');
    engine.step();
    politics = engine.getState().domain.politics as { actions: Array<{ status: string }> };
    expect(politics.actions[0]?.status).toBe('active');
  });

  it('does not re-propose after expiry while hardship signals are unchanged', () => {
    const engine = createEngine({ initialState: {} }, 2);
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
          recoveryTicks: 1,
          durationTicks: 1,
        },
      ],
      producers: [{ id: 'mill' }],
    });
    engine.run(4);
    const actions = (engine.getState().domain.politics as { actions: Array<{ status: string }> })
      .actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe('expired');
  });

  it('keeps protest distinct and does not plan automatic production stoppage', () => {
    const engine = createEngine({ initialState: {} }, 3);
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
          participationBps: 9000,
          recoveryTicks: 1,
          durationTicks: 2,
          actionType: 'protest',
        },
      ],
      producers: [{ id: 'mill' }],
    });
    engine.run(2);
    const politics = engine.getState().domain.politics as {
      actions: Array<{ actionType: string }>;
      impactPlans: Record<string, { capacityBps: number }>;
    };
    expect(politics.actions[0]?.actionType).toBe('protest');
    expect(politics.impactPlans.mill?.capacityBps).toBe(10000);
  });
});
