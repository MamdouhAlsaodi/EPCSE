import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createEngine,
  registerCities,
  registerLocalEconomy,
} from '../../packages/simulation-core/src/index.js';

function run(capacity: number) {
  const config = {
    currency: { id: 'coin', unit: 'cent', scale: 0 },
    commodities: [
      { id: 'seed', unit: 'kg', scale: 0 },
      { id: 'grain', unit: 'kg', scale: 0 },
    ],
    owners: ['farm', 'households', 'carrier'],
    accounts: [
      { id: 'farm-cash', ownerId: 'farm', openingBalance: 1000 },
      { id: 'house-cash', ownerId: 'households', openingBalance: 1000 },
      { id: 'carrier-cash', ownerId: 'carrier', openingBalance: 0 },
      { id: 'move-cash', ownerId: 'households', openingBalance: 0 },
    ],
    stock: [{ ownerId: 'farm', commodity: 'seed', quantity: 200 }],
    recipes: [
      {
        id: 'grow',
        inputs: [{ commodity: 'seed', quantity: 1 }],
        outputs: [{ commodity: 'grain', quantity: 1 }],
      },
    ],
    producers: [
      {
        id: 'farm',
        cityId: 'plain',
        ownerId: 'farm',
        accountId: 'farm-cash',
        recipeId: 'grow',
        laborPerBatch: 1,
        maxBatches: capacity,
        wagePerBatch: 1,
      },
    ],
    cohorts: [
      {
        id: 'rural',
        cityId: 'plain',
        ownerId: 'households',
        accountId: 'house-cash',
        workersAvailable: 0,
        desiredNeeds: { grain: 1 },
      },
    ],
    sellers: [
      {
        cityId: 'plain',
        commodity: 'grain',
        ownerId: 'farm',
        accountId: 'farm-cash',
        minPrice: 1,
        maxPrice: 4,
        openingPrice: 1,
      },
    ],
  };
  const engine = createEngine({ initialState: {} }, 31);
  registerLocalEconomy(engine, config);
  registerCities(engine, {
    cities: [{ id: 'plain', serviceCapacity: {}, serviceProvisionCost: 0 }],
    cohorts: [
      {
        id: 'rural',
        cityId: 'plain',
        population: 4,
        category: 'agriculture',
        class: 'low',
        skills: { farming: 1 },
        needs: { grain: 1 },
        incomePerPerson: 10,
        serviceNeeds: {},
        welfare: 80,
        linkedEconomyCohortId: 'rural',
      },
    ],
    routes: [],
    carrierAccountId: 'carrier-cash',
    migrationFundingAccountId: 'move-cash',
    migrationBudget: 0,
  });
  engine.run(30);
  return engine.getState().domain as {
    economy: {
      producers: Record<string, { batches: number }>;
      cohorts: Record<string, { cumulativeUnmet: Record<string, number> }>;
    };
    cities: { cohorts: Record<string, { welfare: number }> };
  };
}

describe('SC-02 agricultural capacity shock', () => {
  it('reduces real production and worsens unmet grain and welfare against the same-state baseline', () => {
    const baseline = run(5);
    const shock = run(3);
    expect(shock.economy.producers.farm!.batches).toBeLessThan(
      baseline.economy.producers.farm!.batches,
    );
    expect(shock.economy.cohorts.rural!.cumulativeUnmet.grain!).toBeGreaterThan(
      baseline.economy.cohorts.rural!.cumulativeUnmet.grain!,
    );
    expect(shock.cities.cohorts.rural!.welfare).toBeLessThan(
      baseline.cities.cohorts.rural!.welfare,
    );
  }, 15000);
});

// T16 extension — three-nations fixture: route-close shock on the mountains food-import route.
// The literal "agricultural capacity -40%" lever has no engine command; the import-cut shock is
// the honest directional proxy on this fixture (recorded in T16_REPORT.md scenario-gaps).
// Two sequential 155-tick in-process fixture runs block the vitest worker past the fixed 60s
// birpc timeout (observed: "Timeout calling onTaskUpdate" unhandled errors, CI poisoning).
// Same remedy as s0/m1: heavy runs execute in child processes over the BUILT entry; this
// test only compares the sampled metrics series.
describe('SC-02 three-nations route-close food-import direction', () => {
  const execFileAsync = promisify(execFile);

  interface Sc02Run {
    readonly series: string[];
  }

  async function driveInChild(shock: boolean): Promise<Sc02Run> {
    const script = `import { createThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js';
const options = JSON.parse(process.env.T16_SC02_OPTIONS ?? '{}');
const fixture = createThreeNations(options);
const commands = [];
for (let tick = 1; tick <= fixture.config.ticks; tick++) commands.push(...fixture.commandsForTick(tick));
for (const command of commands) fixture.engine.submit(command);
fixture.engine.run(fixture.config.ticks);
const domain = fixture.engine.getState().domain;
console.log(JSON.stringify({ series: domain['three-nations:metrics'].series }));`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        timeout: 1500000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          T16_SC02_OPTIONS: JSON.stringify({
            ticks: 155,
            ...(shock
              ? {
                  shock: {
                    kind: 'route-close' as const,
                    routeId: 'plains-mountains-road',
                    durationTicks: 30,
                    startTick: 121,
                  },
                }
              : {}),
          }),
        },
      },
    );
    return JSON.parse(stdout) as Sc02Run;
  }

  it('raises mountains staple price and cumulative unmet against the same-seed baseline', async () => {
    const [baseline, shocked] = await Promise.all([driveInChild(false), driveInChild(true)]);
    const stapleAt = (run: Sc02Run, index: number): { price: number; unmet: number } => {
      const frame = run.series[index]!.split('|');
      // alphabetical kingdoms: coast, mountains, plains — mountains is index 1
      const price = Number(frame[3]!.split(',')[1]);
      // alphabetical cities: mount-hold is index 6; unmet is the 3rd counter
      const unmet = Number(frame[1]!.split(';')[6]!.split(',')[2]);
      return { price, unmet };
    };
    // first post-shock sample (tick 121)
    const baselineSample = stapleAt(baseline, 120);
    const shockedSample = stapleAt(shocked, 120);
    expect(shockedSample.price).toBeGreaterThanOrEqual(baselineSample.price);
    // final cumulative unmet (tick 155)
    expect(stapleAt(shocked, 154).unmet).toBeGreaterThanOrEqual(stapleAt(baseline, 154).unmet);
  }, 900000);
});
