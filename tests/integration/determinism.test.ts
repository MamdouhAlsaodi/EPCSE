import { describe, expect, it } from 'vitest';
import { createEngine } from '../../packages/simulation-core/src/index.js';

function scenario() {
  const engine = createEngine(
    { worldId: 'sim', initialState: { balances: { a: 1000, b: 0 }, draws: [] } },
    42,
  );
  engine.registerPhaseSystem('production', 'draw', (draft, random) => {
    (draft.draws as number[]).push(Math.floor(random() * 100));
  });
  for (let tick = 1; tick <= 1000; tick += 100) {
    engine.submit({
      commandId: `pay-${tick}`,
      worldId: 'sim',
      requestedTick: tick,
      type: 'transfer',
      payload: { from: 'a', to: 'b', amount: 1 },
    });
  }
  return engine;
}

describe('determinism', () => {
  it(
    'matches domain, state/event hashes, command order, and stable event IDs at every tick across 1000 ticks',
    { timeout: 300000 },
    () => {
      const a = scenario();
      const b = scenario();
      for (let tick = 1; tick <= 1000; tick++) {
        expect(b.step()).toEqual(a.step());
        expect(b.events()).toEqual(a.events());
      }
      expect(a.events().map((event) => event.eventId)).toEqual(
        Array.from({ length: 10 }, (_, index) => `event-${index + 1}`),
      );
      expect(a.getState().domain).toMatchObject({ balances: { a: 990, b: 10 } });
    },
  );
});
