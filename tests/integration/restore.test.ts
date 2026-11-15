import { describe, expect, it } from 'vitest';
import { createEngine } from '../../packages/simulation-core/src/index.js';

function scenario() {
  const engine = createEngine({ worldId: 'sim', initialState: { value: 0, draws: [] } }, 7);
  engine.registerPhaseSystem('production', 'daily', (draft, random) => {
    draft.value = (draft.value as number) + 1;
    (draft.draws as number[]).push(Math.floor(random() * 100));
  });
  return engine;
}

describe('in-memory restore', () => {
  it('continues a 200-tick snapshot with pending commands and full RNG state identically for 100 ticks', () => {
    const running = scenario();
    running.submit({
      commandId: 'deferred',
      worldId: 'sim',
      requestedTick: 250,
      type: 'missing',
      payload: null,
    });
    running.run(200);
    const snapshot = running.snapshotText();
    const branch = scenario();
    branch.restore(snapshot);
    expect(branch.snapshotText()).toBe(snapshot);
    running.run(100);
    branch.run(100);
    expect(branch.snapshotText()).toBe(running.snapshotText());
    expect(branch.getState()).toEqual(running.getState());
    expect(branch.receipts()).toEqual(running.receipts());
    expect(branch.events()).toEqual(running.events());
  });
  it('rejects incompatible versions without changing state', () => {
    const engine = scenario(),
      before = engine.snapshotText();
    expect(() => engine.restore({ ...engine.snapshot(), schemaVersion: 99 })).toThrow(
      /INCOMPATIBLE_VERSION/,
    );
    expect(engine.snapshotText()).toBe(before);
  });
  it('rejects forged inconsistent queues, receipts and counters atomically', () => {
    const engine = scenario();
    engine.submit({
      commandId: 'later',
      worldId: 'sim',
      requestedTick: 4,
      type: 'missing',
      payload: null,
    });
    const before = engine.snapshotText();
    const s = engine.snapshot();
    for (const bad of [
      { ...s, nextSequence: 1 },
      { ...s, nextEventId: 0 },
      { ...s, receipts: [] },
      { ...s, queue: [{ ...(s.queue[0] as Record<string, unknown>), payload: { changed: true } }] },
      { ...s, domain: [] },
    ]) {
      expect(() => engine.restore(bad as typeof s)).toThrow();
      expect(engine.snapshotText()).toBe(before);
    }
  });
  it('rejects missing or contradictory events for applied commands', () => {
    const engine = createEngine({ worldId: 'sim', initialState: { balances: { a: 2, b: 0 } } }, 7);
    engine.submit({
      commandId: 'pay',
      worldId: 'sim',
      requestedTick: 1,
      type: 'transfer',
      payload: { from: 'a', to: 'b', amount: 1 },
    });
    engine.step();
    const before = engine.snapshotText();
    const s = engine.snapshot();
    for (const bad of [
      { ...s, events: [], nextEventId: 1 },
      { ...s, events: [{ ...(s.events[0] as Record<string, unknown>), type: 'other' }] },
      { ...s, events: [{ ...(s.events[0] as Record<string, unknown>), sequence: 99 }] },
    ]) {
      expect(() => engine.restore(bad as typeof s)).toThrow();
      expect(engine.snapshotText()).toBe(before);
    }
  });
});
