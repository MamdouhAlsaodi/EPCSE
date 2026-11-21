import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerLocalEconomy,
  registerPolitics,
} from '../../packages/simulation-core/src/index.js';

describe('SC-05 social action', () => {
  it('reduces actual production and paid wages under organized pressure, not price-only pressure', () => {
    const run = (organization: number) => {
      const engine = createEngine({ initialState: {} }, 7);
      registerLocalEconomy(engine, {
        currency: { id: 'coin', unit: 'cent', scale: 0 },
        commodities: [
          { id: 'ore', unit: 'unit', scale: 0 },
          { id: 'iron', unit: 'unit', scale: 0 },
        ],
        owners: ['mine', 'workers'],
        accounts: [
          { id: 'mine-cash', ownerId: 'mine', openingBalance: 100 },
          { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
        ],
        stock: [{ ownerId: 'mine', commodity: 'ore', quantity: 20 }],
        recipes: [
          {
            id: 'smelt',
            inputs: [{ commodity: 'ore', quantity: 1 }],
            outputs: [{ commodity: 'iron', quantity: 1 }],
          },
        ],
        producers: [
          {
            id: 'mine',
            cityId: 'town',
            ownerId: 'mine',
            accountId: 'mine-cash',
            recipeId: 'smelt',
            laborPerBatch: 1,
            maxBatches: 10,
            wagePerBatch: 1,
          },
        ],
        cohorts: [
          {
            id: 'workers',
            cityId: 'town',
            ownerId: 'workers',
            accountId: 'worker-cash',
            workersAvailable: 10,
            desiredNeeds: {},
          },
        ],
        sellers: [],
      });
      registerPolitics(engine, {
        groups: [
          {
            id: 'miners',
            producerIds: ['mine'],
            cohortId: 'workers',
            organization,
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
      const domain = engine.step().domain;
      const economy = domain.economy as { producers: Record<string, { batches: number }> };
      const accounting = domain.accounting as { accounts: Array<{ id: string; balance: number }> };
      return {
        batches: economy.producers.mine!.batches,
        wages: accounting.accounts.find((a) => a.id === 'worker-cash')!.balance,
        politics: domain.politics as { actions: unknown[] },
      };
    };
    const baseline = run(0),
      strike = run(80);
    expect(strike.batches).toBeLessThan(baseline.batches);
    expect(strike.wages).toBeLessThan(baseline.wages);
    expect(baseline.politics.actions).toHaveLength(0);
  });
  it('rejects high-bound political wage arithmetic without unsafe Number conversion', () => {
    const engine = createEngine({ initialState: {} }, 8);
    registerLocalEconomy(engine, {
      currency: { id: 'coin', unit: 'cent', scale: 0 },
      commodities: [{ id: 'ore', unit: 'unit', scale: 0 }],
      owners: ['mine', 'workers'],
      accounts: [
        { id: 'mine-cash', ownerId: 'mine', openingBalance: Number.MAX_SAFE_INTEGER },
        { id: 'worker-cash', ownerId: 'workers', openingBalance: 0 },
      ],
      stock: [{ ownerId: 'mine', commodity: 'ore', quantity: 1 }],
      recipes: [
        {
          id: 'mine-ore',
          inputs: [{ commodity: 'ore', quantity: 1 }],
          outputs: [{ commodity: 'ore', quantity: 1 }],
        },
      ],
      producers: [
        {
          id: 'mine',
          cityId: 'town',
          ownerId: 'mine',
          accountId: 'mine-cash',
          recipeId: 'mine-ore',
          laborPerBatch: 1,
          maxBatches: 0,
          wagePerBatch: Number.MAX_SAFE_INTEGER,
        },
      ],
      cohorts: [
        {
          id: 'workers',
          cityId: 'town',
          ownerId: 'workers',
          accountId: 'worker-cash',
          workersAvailable: 1,
          desiredNeeds: {},
        },
      ],
      sellers: [],
    });
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
          demand: { wageIncreaseBps: 10000 },
          participationBps: 5000,
          recoveryTicks: 1,
          durationTicks: 5,
          employerAcceptanceBps: 10000,
          employerAccountId: 'mine-cash',
          workerAccountId: 'worker-cash',
          employerOwnerId: 'mine',
          workerOwnerId: 'workers',
        },
      ],
      producers: [{ id: 'mine' }],
    });
    engine.run(2);
    const actionId = (engine.getState().domain.politics as { actions: Array<{ id: string }> })
      .actions[0]!.id;
    engine.submit({
      commandId: 'high-wage',
      type: 'politics.negotiate',
      requestedTick: 3,
      payload: { actionId, decision: 'offer', amount: 1, wageIncreaseBps: 10000 },
    });
    engine.step();
    engine.step();
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow(RangeError);
    expect(engine.snapshotText()).toBe(before);
  });
});

// T16 extension — three-nations fixture: the organized, hardship-eligible mountains miners group
// proposes per the engine's own decision rule; strike pressure lowers sampled produced counts vs
// the same-seed no-social-action run; the healthy coast dockworkers group proposes nothing.
// Fixture drives run in child processes over the BUILT entry (birpc starvation remedy, same as
// s0/m1); this file only asserts on the returned decision/action summaries and series.
describe('SC-05 three-nations miners collective action', () => {
  const execFileAsync = promisify(execFile);

  interface Sc05Run {
    readonly series: string[];
    readonly minersProposed: boolean;
    readonly dockworkersProposed: boolean;
    readonly minersStartedTick: number | null;
  }

  async function driveInChild(socialActionOff: boolean): Promise<Sc05Run> {
    const script = `import { createThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js';
const fixture = createThreeNations({ ticks: 30, variant: { socialActionOff: ${socialActionOff} } });
const commands = [];
for (let tick = 1; tick <= 30; tick++) commands.push(...fixture.commandsForTick(tick));
for (const command of commands) fixture.engine.submit(command);
fixture.engine.run(30);
const domain = fixture.engine.getState().domain;
const politics = domain.politics;
console.log(JSON.stringify({
  series: domain['three-nations:metrics'].series,
  minersProposed: politics.decisions.some((d) => d.agentId === 'group:mountain-miners' && d.selected === 'propose'),
  dockworkersProposed: politics.decisions.some((d) => d.agentId === 'group:coast-dockworkers' && d.selected === 'propose'),
  minersStartedTick: (politics.actions.find((a) => a.groupId === 'mountain-miners') ?? {}).startedTick ?? null,
}));`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        timeout: 1500000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as Sc05Run;
  }

  it('proposes a miners action by rule, lowers produced during action ticks, and the healthy control stays quiet', async () => {
    const [withAction, baseline] = await Promise.all([driveInChild(false), driveInChild(true)]);
    expect(withAction.minersProposed).toBe(true);
    expect(withAction.minersStartedTick).not.toBeNull();
    expect(withAction.dockworkersProposed).toBe(false);

    // sampled produced of the struck producer during action ticks is below baseline for those ticks
    const producedByTick = (run: Sc05Run): number[] => {
      // alphabetical cities: mount-deep is index 4; produced is the 1st counter
      return run.series.map((frame) => Number(frame.split('|')[1]!.split(';')[4]!.split(',')[0]));
    };
    const withProduced = producedByTick(withAction);
    const baselineProduced = producedByTick(baseline);
    // compare only DURING the action window (packet: "sampled produced-count during action
    // ticks is < baseline run's for the same ticks"); metrics index i == tick i+1; action
    // durationTicks is 20 in the fixture
    let compared = 0;
    for (
      let tick = withAction.minersStartedTick!;
      tick <= Math.min(withAction.minersStartedTick! + 19, withProduced.length);
      tick++
    ) {
      const idx = tick - 1;
      if ((baselineProduced[idx] ?? 0) > 0) {
        expect(withProduced[idx]).toBeLessThan(baselineProduced[idx]!);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  }, 900000);
});
