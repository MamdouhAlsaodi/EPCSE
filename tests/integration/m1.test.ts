import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createThreeNations,
  runThreeNations,
} from '../../packages/scenarios/src/three-nations-trade-and-politics.js';
import {
  decideInstitutionalPolicy,
  type AccountingState,
  type EngineEvent,
} from '@epcse/simulation-core';
import { projectWorld, queryEvents, queryJournal } from '../../packages/analytics/src/index.js';

// Long synchronous 1000-tick runs starve vitest's worker RPC (observed: "Timeout calling
// onTaskUpdate" cascades). S0 solved the same problem by moving the long run into an
// asynchronous child process; the SC-15 determinism pair executes the BUILT scenario entry
// twice in parallel children and compares the full deterministic report payloads.
const execFileAsync = promisify(execFile);

interface ThreeNationsDeterminismPayload {
  readonly stateHash: string;
  readonly eventHash: string;
  readonly politics: unknown;
  readonly world: unknown;
  readonly invariants: { readonly moneyConserved: boolean; readonly moneyNonnegative: boolean };
}

async function runThreeNationsInChild(ticks: number): Promise<ThreeNationsDeterminismPayload> {
  const script = `import { runThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js'; const r = runThreeNations({ seed: 42, ticks: ${ticks} }); console.log(JSON.stringify({ stateHash: r.stateHash, eventHash: r.eventHash, politics: r.politics, world: r.world, invariants: r.invariants }));`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 1500000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as ThreeNationsDeterminismPayload;
}

// Any multi-hundred-tick in-process run blocks the worker past vitest's fixed 60s birpc
// timeout ("Timeout calling onTaskUpdate" unhandled errors, poisoned exit codes). Same
// remedy as s0: heavy runs execute in child processes over the BUILT entry; this variant
// exports the final engine state slices so directional assertions stay in this process.
interface ChildFixtureRun {
  readonly tick: number;
  readonly hash: string;
  readonly eventHash: string;
  readonly domain: Record<string, unknown>;
  readonly events: EngineEvent[];
}

async function runFixtureInChild(options: {
  ticks: number;
  shock?: unknown;
}): Promise<ChildFixtureRun> {
  const script = `import { createThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js';
const options = JSON.parse(process.env.T16_CHILD_OPTIONS ?? '{}');
const fixture = createThreeNations(options);
for (let tick = 1; tick <= fixture.config.ticks; tick++) {
  for (const command of fixture.commandsForTick(tick)) fixture.engine.submit(command);
  fixture.engine.step();
}
const state = fixture.engine.getState();
console.log(JSON.stringify({ tick: state.tick, hash: state.hash, eventHash: state.eventHash, domain: state.domain, events: fixture.engine.events() }));`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 1500000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, T16_CHILD_OPTIONS: JSON.stringify({ seed: 42, ...options }) },
  });
  return JSON.parse(stdout) as ChildFixtureRun;
}

// Restore/continue convergence also runs inside ONE child (two engines driven in sync there)
// so neither 60-tick half ever blocks the vitest worker.
async function restoreConvergenceInChild(): Promise<{ full: string; branch: string }> {
  const script = `import { createThreeNations } from './packages/scenarios/dist/three-nations-trade-and-politics.js';
const fixture = createThreeNations({ ticks: 60 });
const schedule = [];
for (let tick = 1; tick <= 60; tick++) schedule.push([...fixture.commandsForTick(tick)]);
for (let tick = 1; tick <= 30; tick++)
  for (const command of schedule[tick - 1]) fixture.engine.submit(command);
fixture.engine.run(30);
const snapshot = fixture.engine.snapshotText();
const branch = createThreeNations({ ticks: 60 });
branch.engine.restore(snapshot);
for (let tick = 31; tick <= 60; tick++) {
  for (const command of schedule[tick - 1]) {
    fixture.engine.submit(command);
    branch.engine.submit(command);
  }
  fixture.engine.step();
  branch.engine.step();
}
console.log(JSON.stringify({ full: fixture.engine.getState().hash, branch: branch.engine.getState().hash }));`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 1500000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as { full: string; branch: string };
}

describe('M1 integration: three-nations-trade-and-politics fixture', () => {
  it('exposes default counts, institutions, and the full four-form institutional rule table', () => {
    const { config } = createThreeNations();
    expect(config.counts).toEqual({
      kingdoms: 3,
      cities: 12,
      goods: 15,
      sectors: 6,
      classes: 5,
      governmentFormsSupported: 4,
    });
    expect(config.kingdomGovernmentForms).toEqual({
      plains: 'monarchy',
      mountains: 'city-council',
      coast: 'parliamentary',
    });
    // institutions registered per kingdom: an institutional policy records the monarchy authority
    // decision with its rule-table constraints (engine keeps the mapping in config digest form)
    const fixture = createThreeNations({ ticks: 60, variant: { localPurchaseTax: true } });
    for (const command of fixture.commandsForTick(2)) fixture.engine.submit(command);
    fixture.engine.run(3);
    const government = fixture.engine.getState().domain.government as {
      kingdoms: unknown[];
      authorityDecisions: Array<{ kingdomId: string; decision: { constraints: string[] } }>;
    };
    expect(government.kingdoms).toHaveLength(3);
    const authority = government.authorityDecisions.find((d) => d.kingdomId === 'plains');
    expect(authority).toBeDefined();
    expect(authority!.decision.constraints).toEqual([
      'legitimacy>=40',
      'support>=30',
      'quorum>=0',
      'veto-blocks=false',
    ]);
    // pure-function rule table covers all four supported forms (central-republic has no kingdom)
    for (const institution of [
      'monarchy',
      'city-council',
      'parliamentary',
      'central-republic',
    ] as const) {
      const approved = decideInstitutionalPolicy({
        institution,
        legitimacy: 80,
        quorum: 80,
        support: 80,
        oppositionVeto: false,
      });
      const blocked = decideInstitutionalPolicy({
        institution,
        legitimacy: institution === 'central-republic' ? 59 : 10,
        quorum: 0,
        support: institution === 'parliamentary' ? 49 : 10,
        oppositionVeto: true,
      });
      expect(approved.approved).toBe(true);
      expect(blocked.approved).toBe(false);
      expect(approved.effectiveDelay).toBeGreaterThan(0);
    }
  }, 600000);

  it('follows configuration: kingdom subset changes resolved counts', () => {
    const report = runThreeNations({ kingdoms: ['plains', 'mountains'], ticks: 4 });
    expect(report.config.counts.kingdoms).toBe(2);
    expect(report.config.counts.cities).toBe(8);
    expect(report.config.cityIds).toHaveLength(8);
    expect(report.config.kingdomGovernmentForms).not.toHaveProperty('coast');
  }, 600000);

  it('runs 60 ticks with every phase system firing, real conversion/departure/arrival/settlement, conservation, and reconciled analytics', async () => {
    const run = await runFixtureInChild({ ticks: 60 });
    const domain = run.domain;
    // every merged subsystem is live in the domain
    for (const key of [
      'accounting',
      'economy',
      'firms',
      'cities',
      'logistics',
      'government',
      'diplomacy',
      'politics',
      'three-nations:metrics',
    ]) {
      expect(domain[key], `domain key ${key}`).toBeDefined();
    }
    // politics decisions logged by the engine's own rules
    const politics = domain.politics as { decisions: unknown[]; actions: unknown[] };
    expect(politics.decisions.length).toBeGreaterThan(0);
    const accounting = domain.accounting as AccountingState;
    const journal = accounting.journal;
    const byCause = (prefix: string) => journal.filter((e) => e.causeId.startsWith(prefix));
    expect(byCause('production:').length).toBeGreaterThan(0); // production conversion
    expect(
      byCause('logistics:').filter((e) => e.causeId.includes(':depart')).length,
    ).toBeGreaterThan(0);
    expect(
      byCause('logistics:').filter((e) => e.causeId.includes(':arrive')).length,
    ).toBeGreaterThan(0);
    expect(journal.filter((e) => e.type === 'consume').length).toBeGreaterThan(0);
    // money total == opening total (conservation) and nothing negative
    const opening = accounting.openingBalances.reduce((sum, e) => sum + e.balance, 0);
    expect(accounting.accounts.reduce((sum, e) => sum + e.balance, 0)).toBe(opening);
    expect(accounting.accounts.every((a) => a.balance >= 0)).toBe(true);
    expect(accounting.stock.every((s) => s.quantity >= 0)).toBe(true);
    // metrics series length == ticks
    const metrics = domain['three-nations:metrics'] as { series: string[] };
    expect(metrics.series).toHaveLength(60);
    // analytics projection of the final state reconciles: journal-derived totals equal projection
    const projection = projectWorld(domain, 60);
    const producedFromJournal = byCause('production:').filter(
      (e) => e.type === 'conversion',
    ).length;
    const departedFromJournal = byCause('logistics:').filter((e) =>
      e.causeId.endsWith(':depart'),
    ).length;
    const arrivedFromJournal = byCause('logistics:').filter((e) =>
      e.causeId.endsWith(':arrive'),
    ).length;
    expect(projection.world.produced).toBe(producedFromJournal);
    expect(projection.world.departed).toBe(departedFromJournal);
    expect(projection.world.arrived).toBe(arrivedFromJournal);
    const unmetFromState = Object.values(
      (domain.economy as { cohorts: Record<string, { cumulativeUnmet: Record<string, number> }> })
        .cohorts,
    ).reduce((sum, c) => sum + Object.values(c.cumulativeUnmet).reduce((a, b) => a + b, 0), 0);
    expect(projection.world.unmet).toBe(unmetFromState);
  }, 600000);

  it('is deterministic: two identically-driven engines produce identical state and event hashes', async () => {
    const runOnce = async () => {
      const run = await runFixtureInChild({ ticks: 60 });
      return { state: run.hash, events: run.eventHash };
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(first).toEqual(second);
    expect(first.state).toMatch(/^[a-f0-9]{64}$/);
    expect(first.events).toMatch(/^[a-f0-9]{64}$/);
  }, 600000);

  it('restores a tick-30 snapshot into a fresh engine and converges to the same tick-60 state', async () => {
    const { full, branch } = await restoreConvergenceInChild();
    expect(branch).toBe(full);
    expect(full).toMatch(/^[a-f0-9]{64}$/);
  }, 600000);

  it('rejects invalid shocks without constructing engine state', () => {
    expect(() =>
      createThreeNations({
        shock: {
          kind: 'route-close',
          routeId: 'plains-mountains-road',
          durationTicks: 5,
          startTick: 120,
        },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createThreeNations({
        shock: { kind: 'route-close', routeId: 'unknown-route', durationTicks: 5, startTick: 121 },
      }),
    ).toThrow(/routeId/);
    // factory-level validation: nothing was ever created, so there is no partial state to inspect
  }, 600000);
});

describe('m1: shocks, SC-15 determinism at 1000 ticks, reconciliation, pagination', () => {
  it('route-close shock stops departures on the closed route during the closure window and reopens it after', async () => {
    // The fixture schedules plains-mountains-road departures on a 100-tick cadence
    // (ticks 3, 103, 203, …), so the closure window must cover the scheduled tick-203
    // departure to prove the block; the shock closes the route over [200, 230).
    const shock = {
      kind: 'route-close' as const,
      routeId: 'plains-mountains-road',
      startTick: 200,
      durationTicks: 30,
    };
    const [closed, baseline] = await Promise.all([
      runFixtureInChild({ ticks: 250, shock }),
      runFixtureInChild({ ticks: 250 }),
    ]);
    const shipmentsOf = (run: ChildFixtureRun) =>
      ((
        run.domain.logistics as
          | { shipments?: Array<{ routeId: string; departureTick: number; status: string }> }
          | undefined
      )?.shipments?.filter((s) => s.routeId === 'plains-mountains-road') ?? []) as Array<{
        routeId: string;
        departureTick: number;
        status: string;
      }>;
    const departedDuringClosure = (shipments: ReturnType<typeof shipmentsOf>) =>
      shipments.filter((s) => s.departureTick >= 200 && s.departureTick < 230).length;
    // Directional rule: departures on a closed route are rejected, so the closure window
    // [200,230) has zero departures under the shock while the baseline's tick-203 departure flows.
    expect(departedDuringClosure(shipmentsOf(closed))).toBe(0);
    expect(departedDuringClosure(shipmentsOf(baseline))).toBeGreaterThan(0);
    // After the reopen command the route is no longer marked closed.
    const closedRouteIds = (closed.domain.logistics as { closedRouteIds?: string[] } | undefined)
      ?.closedRouteIds;
    expect(closedRouteIds).toEqual([]);
  }, 1800000);

  it('import-tariff shock creates duty journal entries caused by the government policy, debiting the buyer and crediting the importing treasury', async () => {
    const shock = {
      kind: 'import-tariff' as const,
      routeId: 'coast-plain-road',
      importKingdomId: 'plains',
      commodity: 'clothes',
      amount: 10,
      startTick: 150,
      durationTicks: 100,
    };
    const run = await runFixtureInChild({ ticks: 300, shock });
    const journal = (run.domain.accounting as unknown as AccountingState).journal;
    const duties = queryJournal(
      journal,
      { causePrefix: 'government:shock-import-tariff:shipment:' },
      { size: 100, offset: 0 },
    );
    expect(duties.total).toBeGreaterThan(0);
    const buyerId = 'coast-trader-cash';
    const treasuryId = 'plains-treasury';
    let dutyCoin = 0;
    for (const entry of duties.items) {
      // Directional rule: each duty is a real payment effect debiting the buyer side and
      // crediting the importing kingdom's treasury account ({debit, credit, amount} shape).
      const effect = entry.effects[0] as { debit?: string; credit?: string; amount?: number };
      expect(effect.debit).toBe(buyerId);
      expect(effect.credit).toBe(treasuryId);
      expect(effect.amount).toBeGreaterThan(0);
      dutyCoin += effect.amount ?? 0;
    }
    expect(dutyCoin).toBeGreaterThan(0);
    expect(
      (run.domain.accounting as unknown as AccountingState).accounts.find(
        (a) => a.id === treasuryId,
      ),
    ).toBeDefined();
  }, 1800000);

  it('SC-15 determinism: two fresh child-process 1000-tick runs produce identical hashes, politics counts, and world totals', async () => {
    // Each child executes the BUILT scenario entry (packages/scenarios/dist) from a fresh
    // process with the same seed/config; the test only compares the deterministic payloads.
    const [a, b] = await Promise.all([runThreeNationsInChild(1000), runThreeNationsInChild(1000)]);
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.eventHash).toBe(b.eventHash);
    expect(a.politics).toEqual(b.politics);
    expect(a.world).toEqual(b.world);
    expect(a.invariants.moneyConserved).toBe(true);
    expect(a.invariants.moneyNonnegative).toBe(true);
  }, 1800000);

  it('reconciliation: final analytics projection city sums == kingdom sums == world totals == accounting treasuries', async () => {
    const run = await runFixtureInChild({ ticks: 250 });
    const world = projectWorld(run.domain, run.tick);
    const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
    for (const field of ['produced', 'consumed', 'unmet', 'departed', 'arrived'] as const) {
      expect(sum(Object.values(world.cities).map((c) => c[field]))).toBe(world.world[field]);
      expect(sum(Object.values(world.kingdoms).map((k) => k[field]))).toBe(world.world[field]);
      expect(Number.isInteger(world.world[field])).toBe(true);
    }
    const accounting = run.domain.accounting as unknown as AccountingState;
    for (const kingdomId of ['plains', 'mountains', 'coast']) {
      const projected = world.kingdoms[kingdomId];
      expect(projected).toBeDefined();
      const account = accounting.accounts.find((a) => a.id === `${kingdomId}-treasury`);
      expect(account).toBeDefined();
      expect(projected!.treasury).toBe(account!.balance);
    }
    expect(sum(Object.values(world.kingdoms).map((k) => k.treasury))).toBe(world.world.treasury);
  }, 1800000);

  it('event pagination over the causal accounting journal and queryEvents page math: total/hasMore/items and stable order', async () => {
    const run = await runFixtureInChild({ ticks: 250 });
    // The causal per-effect ledger is the accounting journal. The lean fixture deliberately
    // bounds journal load, so magnitude is not the assertion: multi-page mechanics are. The
    // engine's `events()` list is a command-level log (one entry per applied command) and
    // stays small by design; both paginators get exact slice math on their real lengths.
    const entries = (run.domain.accounting as unknown as AccountingState).journal;
    expect(entries.length).toBeGreaterThan(100); // enough for at least two full pages at size 100
    const first = queryJournal(entries, {}, { size: 100, offset: 0 });
    expect(first.total).toBe(entries.length);
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.items).toEqual(entries.slice(0, 100));
    const mid = queryJournal(entries, {}, { size: 100, offset: 100 });
    expect(mid.items).toEqual(entries.slice(100, 200));
    expect(mid.hasMore).toBe(entries.length > 200);
    const lastOffset = Math.floor(entries.length / 100) * 100;
    const last = queryJournal(entries, {}, { size: 100, offset: lastOffset });
    expect(last.items).toEqual(entries.slice(lastOffset));
    expect(last.items.length).toBe(entries.length - lastOffset);
    expect(last.hasMore).toBe(false);
    // filtered pagination: cause-prefixed subset, deterministic order preserved
    const conversion = queryJournal(
      entries,
      { causePrefix: 'production:' },
      {
        size: 50,
        offset: 0,
      },
    );
    expect(conversion.items).toEqual(
      entries.filter((entry) => entry.causeId.startsWith('production:')).slice(0, 50),
    );
    expect(conversion.total).toBe(
      entries.filter((entry) => entry.causeId.startsWith('production:')).length,
    );
    // command-level event log: small by design; page math and stable order asserted exactly
    const events = run.events;
    expect(events.length).toBeGreaterThan(0);
    const firstEventPage = queryEvents(events, {}, { size: 10, offset: 0 });
    expect(firstEventPage.total).toBe(events.length);
    expect(firstEventPage.items).toEqual(events.slice(0, Math.min(10, events.length)));
    expect(firstEventPage.hasMore).toBe(events.length > 10);
    const midEventPage = queryEvents(
      events,
      {},
      {
        size: 10,
        offset: Math.min(5, Math.max(0, events.length - 1)),
      },
    );
    expect(midEventPage.items).toEqual(
      events.slice(Math.min(5, Math.max(0, events.length - 1)), Math.min(15, events.length)),
    );
  }, 1800000);
});
