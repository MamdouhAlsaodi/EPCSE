import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';
import { advanceResponsively } from './advance-responsively.js';

describe('responsive simulation advance', () => {
  it('matches a single uninterrupted run including state and event hashes', async () => {
    const continuous = createThreeNations({ ticks: 8 });
    const yielding = createThreeNations({ ticks: 8 });
    for (let tick = 1; tick <= 8; tick++) {
      for (const command of continuous.commandsForTick(tick)) continuous.engine.submit(command);
      for (const command of yielding.commandsForTick(tick)) yielding.engine.submit(command);
    }
    continuous.engine.run(8);
    await advanceResponsively(yielding.engine, 8);
    expect(yielding.engine.getState()).toEqual(continuous.engine.getState());
    expect(yielding.engine.events()).toEqual(continuous.engine.events());
  }, 120000);
});
