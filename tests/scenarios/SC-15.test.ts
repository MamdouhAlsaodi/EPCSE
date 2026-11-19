// SC-15 — three-nations fixture: two full 1000-tick built-CLI runs (spawn
// apps/cli/dist/main.js like vs.test.ts does; 2 runs × seed 42) must produce identical stdout
// including the state/event hashes. Heavy in-process runs stay out of Vitest workers for the
// same rationale as vs.test.ts: the runner's event loop must stay responsive during the long
// engine calculation, and the full two-run 1000-tick check lives in a dedicated file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const cli = promisify(execFile);

describe('SC-15 built CLI determinism (three-nations, 1000 ticks, twice)', () => {
  it('prints byte-identical 1000-tick reports across two runs', async () => {
    const args = [
      'apps/cli/dist/main.js',
      'run',
      '--scenario',
      'three-nations-trade-and-politics',
      '--seed',
      '42',
      '--ticks',
      '1000',
    ];
    const [first, second] = await Promise.all([
      cli(process.execPath, args, { timeout: 1800000 }),
      cli(process.execPath, args, { timeout: 1800000 }),
    ]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toMatch(/State hash: [a-f0-9]{64}/);
    expect(first.stdout).toMatch(/Event hash: [a-f0-9]{64}/);
  }, 2400000);
});
