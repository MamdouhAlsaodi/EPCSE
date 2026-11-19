import { describe, expect, it } from 'vitest';
import { projectWorld, projectSeries } from '../../packages/analytics/src/index.js';
import {
  queryEvents,
  queryJournal,
  type EventFilter,
  type Page,
} from '../../packages/analytics/src/index.js';
import type { AccountingJournalEntry, EngineEvent } from '@epcse/simulation-core';

// Constructed small domain snapshot (no engine run needed): two cities in two kingdoms, with
// fixture-shaped compact metrics frames (version 1; alphabetical city/kingdom order).
function smallDomain() {
  return {
    'three-nations:metrics': {
      version: 1,
      series: ['1|4,2,1,1,0;2,3,0,0,1|900,500|3,7', '2|8,4,1,2,1;4,6,0,0,2|880,480|4,7'],
    },
    logistics: {
      cityKingdomIds: { alpha: 'north', beta: 'south' },
    },
  } as Readonly<Record<string, unknown>>;
}
describe('analytics projections', () => {
  it('projects the world from the latest fixture metrics sample with exact reconciliation', () => {
    const world = projectWorld(smallDomain(), 2);
    expect(world.tick).toBe(2);
    expect(world.cities.alpha).toMatchObject({
      produced: 8,
      consumed: 4,
      unmet: 1,
      departed: 2,
      arrived: 1,
    });
    expect(world.kingdoms.north?.treasury).toBe(880);
    expect(world.kingdoms.north?.produced).toBe(8);
    expect(world.world.produced).toBe(12);
    expect(world.world.departed).toBe(2);
    expect(world.world.arrived).toBe(3);
    expect(world.world.unmet).toBe(1);
    expect(world.world.treasury).toBe(1360);
  });

  it('reconciles city sums == kingdom sums == world totals exactly', () => {
    const world = projectWorld(smallDomain(), 2);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    for (const field of ['produced', 'consumed', 'unmet', 'departed', 'arrived'] as const) {
      expect(sum(Object.values(world.cities).map((c) => c[field]))).toBe(world.world[field]);
      expect(sum(Object.values(world.kingdoms).map((k) => k[field]))).toBe(world.world[field]);
    }
    expect(sum(Object.values(world.kingdoms).map((k) => k.treasury))).toBe(world.world.treasury);
  });

  it('contains no NaN or Infinity anywhere in the projection', () => {
    const world = projectWorld(smallDomain(), 2) as unknown as Record<string, unknown>;
    const walk = (value: unknown): void => {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(world);
  });

  it('rejects metrics with an unsupported version or missing domain key', () => {
    const bad = { 'three-nations:metrics': { version: 99, series: [] } };
    expect(() => projectSeries(bad)).toThrow(/version/i);
    expect(() => projectSeries({})).toThrow(/domain key/i);
    expect(() =>
      projectSeries({ 'three-nations:metrics': { version: 1, series: ['garbage'] } }),
    ).toThrow(/frame/);
  });

  it('returns the full series with validated frames', () => {
    const frames = projectSeries(smallDomain());
    expect(frames).toHaveLength(2);
    expect(frames[0]?.tick).toBe(1);
    expect(frames[1]?.tick).toBe(2);
    expect(frames[1]?.cities.alpha?.produced).toBe(8);
    expect(frames[1]?.cities.beta?.arrived).toBe(2);
    expect(frames[1]?.kingdoms.south?.treasury).toBe(480);
  });
});

const events: EngineEvent[] = [
  { eventId: 'e1', tick: 1, phase: 1, sequence: 1, type: 'logistics.depart', commandId: 'c1' },
  { eventId: 'e2', tick: 2, phase: 1, sequence: 2, type: 'government.policy', commandId: 'c2' },
  { eventId: 'e3', tick: 2, phase: 9, sequence: 3, type: 'logistics.depart', commandId: 'c3' },
  { eventId: 'e4', tick: 5, phase: 1, sequence: 4, type: 'diplomacy.decision', commandId: 'c4' },
];

const journal: AccountingJournalEntry[] = [
  {
    transactionId: 't1',
    causeId: 'logistics:s1:fare',
    type: 'payment',
    effects: [],
    rationale: 'freight',
  },
  {
    transactionId: 't2',
    causeId: 'government:sub',
    type: 'payment',
    effects: [],
    rationale: 'subsidy',
  },
  {
    transactionId: 't3',
    causeId: 'logistics:s2:depart',
    type: 'depart',
    effects: [],
    rationale: 'departure',
  },
];

describe('analytics event queries', () => {
  it('is deterministic: same input twice gives identical output', () => {
    const filter: EventFilter = { types: ['logistics.depart'], tickFrom: 1, tickTo: 3 };
    const page: Page = { size: 10, offset: 0 };
    expect(queryEvents(events, filter, page)).toEqual(queryEvents(events, filter, page));
  });

  it('filters by type and tick window without reordering', () => {
    const result = queryEvents(
      events,
      { types: ['logistics.depart'], tickFrom: 2 },
      {
        size: 10,
        offset: 0,
      },
    );
    expect(result.total).toBe(1);
    expect(result.items.map((e) => e.eventId)).toEqual(['e3']);
    expect(result.hasMore).toBe(false);
  });

  it('filters by commandId', () => {
    const result = queryEvents(events, { commandId: 'c4' }, { size: 10, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items[0]?.commandId).toBe('c4');
  });

  it('stitches pages without duplication or loss and reports hasMore', () => {
    const filter: EventFilter = {};
    const pages: EngineEvent[] = [];
    let offset = 0;
    let total = -1;
    let guard = 0;
    while (guard++ < 20) {
      const result = queryEvents(events, filter, { size: 3, offset });
      total = result.total;
      pages.push(...result.items);
      if (!result.hasMore) break;
      offset += 3;
    }
    expect(total).toBe(events.length);
    expect(pages).toEqual(events);
    const empty = queryEvents(events, {}, { size: 3, offset: 4 });
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.total).toBe(4);
  });

  it('throws RangeError on invalid page size or offset', () => {
    expect(() => queryEvents(events, {}, { size: 0, offset: 0 })).toThrow(RangeError);
    expect(() => queryEvents(events, {}, { size: 1001, offset: 0 })).toThrow(RangeError);
    expect(() => queryEvents(events, {}, { size: 5, offset: -1 })).toThrow(RangeError);
    expect(() => queryEvents(events, {}, { size: 1.5, offset: 0 })).toThrow(RangeError);
  });
});

describe('analytics journal queries', () => {
  it('filters by causePrefix and type deterministically', () => {
    const page: Page = { size: 10, offset: 0 };
    expect(queryJournal(journal, { causePrefix: 'logistics:' }, page).total).toBe(2);
    expect(queryJournal(journal, { type: 'payment' }, page).total).toBe(2);
    const first = queryJournal(journal, { causePrefix: 'logistics:' }, page);
    expect(first).toEqual(queryJournal(journal, { causePrefix: 'logistics:' }, page));
    expect(first.items.map((e) => e.transactionId)).toEqual(['t1', 't3']);
  });

  it('pages the journal without duplication or loss', () => {
    const pages: AccountingJournalEntry[] = [];
    let offset = 0;
    let total = -1;
    let guard = 0;
    while (guard++ < 20) {
      const result = queryJournal(journal, {}, { size: 2, offset });
      total = result.total;
      pages.push(...result.items);
      if (!result.hasMore) break;
      offset += 2;
    }
    expect(total).toBe(3);
    expect(pages).toEqual(journal);
  });

  it('throws RangeError on invalid pages', () => {
    expect(() => queryJournal(journal, {}, { size: 0, offset: 0 })).toThrow(RangeError);
    expect(() => queryJournal(journal, {}, { size: 2000, offset: 0 })).toThrow(RangeError);
    expect(() => queryJournal(journal, {}, { size: 2, offset: -2 })).toThrow(RangeError);
  });
});
