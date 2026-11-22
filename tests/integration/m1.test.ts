import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createThreeNations,
  runThreeNations,
  threeNationsSummary,
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
    timeout: 3000000,
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

  it('funds demanded city services through the shared accounting journal and applies coverage', () => {
    const fixture = createThreeNations();
    fixture.engine.run(1);
    const domain = fixture.engine.getState().domain;
    const cities = domain.cities as {
      cohorts: Record<string, { serviceCoverage: Record<string, number> }>;
    };
    expect(cities.cohorts['plain-central-residents']?.serviceCoverage.care).toBe(50);

    const accounting = domain.accounting as AccountingState;
    const serviceEntries = accounting.journal.filter(
      (entry) => entry.causeId === 'city-service:plain-central',
    );
    expect(serviceEntries).toHaveLength(1);
    expect(serviceEntries[0]?.type).toBe('payment');
    expect(serviceEntries[0]?.effects).toContainEqual({
      debit: 'plain-central-residents-cash',
      credit: 'plains-treasury',
      amount: 1,
      stockDeltas: [],
    });
    expect(
      accounting.accounts.find((account) => account.id === 'plain-central-residents-cash')?.balance,
    ).toBeLessThan(200);
    expect(
      accounting.accounts.find((account) => account.id === 'plains-treasury')?.balance,
    ).toBeGreaterThan(5000);
  });

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

  it('summary carries an explicit deterministic final label block (harness, not M1 acceptance, SC-11 excluded)', () => {
    const lines = threeNationsSummary(runThreeNations({ seed: 42, ticks: 5 }));
    const label = lines.find((line) => line.startsWith('Final label: three-nations harness'))!;
    expect(label).toBeDefined();
    expect(label).toContain('fixture v');
    expect(label).toContain('seed 42');
    expect(label).toContain('ticks 5');
    const state = lines.find((line) => line.startsWith('State hash: '))!;
    const events = lines.find((line) => line.startsWith('Event hash: '))!;
    expect(label).toContain(state.replace('State hash: ', ''));
    expect(label).toContain(events.replace('Event hash: ', ''));
    const status = lines.find((line) => line.startsWith('Status: '))!;
    expect(status).toContain('NOT M1 acceptance');
    expect(status).toContain('SC-11');
    expect(status).toContain('excluded');
    // determinism: same run config yields byte-identical summary (no wall-clock in the block)
    expect(threeNationsSummary(runThreeNations({ seed: 42, ticks: 5 }))).toEqual(lines);
  }, 600000);

  it('publishes metrics v2 frames whose sparse price samples match economy.quotes at the final tick', () => {
    const fixture = createThreeNations({ ticks: 3 });
    for (let tick = 1; tick <= 3; tick++) {
      for (const command of fixture.commandsForTick(tick)) fixture.engine.submit(command);
      fixture.engine.step();
    }
    const domain = fixture.engine.getState().domain;
    const metrics = domain['three-nations:metrics'] as { version: number; series: string[] };
    expect(metrics.version).toBe(2);
    expect(metrics.series).toHaveLength(3);
    // publish is the last phase, so the final frame's samples must equal the final quotes exactly
    const lastLine = metrics.series[metrics.series.length - 1]!;
    const segments = lastLine.split('|');
    expect(segments).toHaveLength(5);
    const quotes = (domain.economy as { quotes: Record<string, { price: number }> }).quotes;
    const expected: Record<string, Record<string, number>> = {};
    for (const [k, q] of Object.entries(quotes)) {
      const [cityId, commodityId] = JSON.parse(k) as [string, string];
      (expected[cityId] ??= {})[commodityId] = q.price;
    }
    const parsed: Record<string, Record<string, number>> = {};
    for (const entry of segments[4]!.split(';').filter(Boolean)) {
      const [cityId, commodityId, price] = entry.split(':');
      if (!cityId || !commodityId) throw new Error('malformed sample entry');
      (parsed[cityId] ??= {})[commodityId] = Number(price);
    }
    expect(Object.keys(parsed).length).toBeGreaterThan(0); // tick > 0 with live quotes
    expect(parsed).toEqual(expected);
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

  it('SC-15 regression: a fresh 1000-tick child matches the canonical hashes', async () => {
    // The independent two-run comparison is in tests/scenarios/SC-15 and CI. This
    // separate built-scenario run pins the canonical hashes; concurrent CPU-heavy
    // tests on hosted runners can require more than 25 minutes for this one child.
    const a = await runThreeNationsInChild(1000);
    expect(a.stateHash).toBe('f7052866af0c7dc663aa4c12e256c3f3defda957b31ddd81346dc9a4372b12de');
    expect(a.eventHash).toBe('af179ccaea4845026a76e10e033310b17a83aee654cad9d2703da28bc7c5182e');
    expect(a.invariants.moneyConserved).toBe(true);
    expect(a.invariants.moneyNonnegative).toBe(true);
  }, 3300000);

  it('W3 reconciliation: event pagination and tick windows over the real engine event ledger', async () => {
    const run = await runFixtureInChild({ ticks: 60 });
    const events = run.events;
    expect(events.length).toBeGreaterThan(5);
    // total == array length for several windows; every page matches an exact array slice
    for (const [size, offset] of [
      [10, 0],
      [7, 5],
      [10, Math.floor(events.length / 10) * 10],
    ] as const) {
      const page = queryEvents(events, {}, { size, offset });
      expect(page.total).toBe(events.length);
      expect(page.items).toEqual(events.slice(offset, offset + size));
    }
    // concatenation of all pages deep-equals the full array in order (byte-stable)
    const stitched: EngineEvent[] = [];
    let offset = 0;
    let guard = 0;
    let boundaryHasMore = true;
    while (guard++ < 1000) {
      const page = queryEvents(events, {}, { size: 5, offset });
      stitched.push(...page.items);
      boundaryHasMore = page.hasMore;
      if (offset + 5 >= page.total) {
        // exact boundary math: offset+size >= total → hasMore must be false
        expect(page.hasMore).toBe(false);
        break;
      }
      expect(page.hasMore).toBe(true);
      offset += 5;
    }
    expect(stitched).toEqual(events);
    void boundaryHasMore;
    // a page ending exactly at total reports hasMore false
    const exact = queryEvents(events, {}, { size: events.length, offset: 0 });
    expect(exact.hasMore).toBe(false);
    const onePast = queryEvents(events, {}, { size: 1, offset: events.length - 1 });
    expect(onePast.hasMore).toBe(false);
    // filtered subsets: counts match a manual count over the same array, items match the slice
    const byType = events.filter((e) => e.type.startsWith('government.'));
    const typed = queryEvents(events, { types: ['government.policy'] }, { size: 1000, offset: 0 });
    expect(typed.total).toBe(events.filter((e) => e.type === 'government.policy').length);
    expect(typed.items).toEqual(events.filter((e) => e.type === 'government.policy'));
    expect(typed.total).toBeLessThanOrEqual(byType.length);
    // time-range filter over a real run: ticks reconcile to real event ticks
    const ticks = events.map((e) => e.tick);
    const minTick = Math.min(...ticks);
    const maxTick = Math.max(...ticks);
    const midFrom = Math.min(minTick + 5, maxTick);
    const ranged = queryEvents(
      events,
      { tickFrom: midFrom, tickTo: maxTick },
      { size: 1000, offset: 0 },
    );
    expect(ranged.total).toBe(events.filter((e) => e.tick >= midFrom && e.tick <= maxTick).length);
    expect(ranged.items.every((e) => e.tick >= midFrom && e.tick <= maxTick)).toBe(true);
    expect(ranged.items).toEqual(events.filter((e) => e.tick >= midFrom && e.tick <= maxTick));
    expect(ranged.total).toBeLessThan(events.length); // window actually narrowed
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
