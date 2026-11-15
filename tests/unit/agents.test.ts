import { describe, expect, it } from 'vitest';
import { decideIndependently } from '../../packages/simulation-core/src/services/agents/index.js';

describe('independent agents', () => {
  it('records alternatives, constraints, reason and a deterministic tie break', () => {
    expect(
      decideIndependently({
        agentId: 'north',
        options: [
          { id: 'accept', score: 3 },
          { id: 'refuse', score: 3 },
        ],
        information: ['route=open'],
        constraints: ['treasury>=0'],
      }),
    ).toMatchObject({
      selected: 'accept',
      alternatives: ['accept', 'refuse'],
      reason: expect.any(String),
      agentId: 'north',
    });
  });
});
