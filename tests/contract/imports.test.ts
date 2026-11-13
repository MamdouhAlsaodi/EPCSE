import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '@epcse/cli';
import { scenarioStatus } from '@epcse/scenarios';
import { engineStatus } from '@epcse/simulation-core';

describe('bootstrap import contract', () => {
  it('simulation-core imports cleanly and reports an explicit not-implemented status', () => {
    expect(engineStatus).toEqual({ implemented: false });
  });

  it('scenarios imports simulation-core through the real workspace link', () => {
    expect(scenarioStatus).toEqual({
      implemented: false,
      core: '@epcse/simulation-core',
      coreImplemented: false,
    });
  });

  it('the CLI reports an explicit stub with no fictional simulation data', () => {
    expect(run()).toEqual([
      'EPCSE CLI - Economic, Political & Civilization Simulation Engine',
      'simulation-core: no simulation implemented',
      'scenarios: no scenarios implemented',
      'This is a bootstrap stub; no simulation, economics or world rules exist yet.',
    ]);
  });

  it('workspace packages declare no dependencies outside this workspace', () => {
    const allowed = new Set(['@epcse/simulation-core', '@epcse/scenarios']);
    const paths = [
      'packages/simulation-core/package.json',
      'packages/scenarios/package.json',
    ] as const;
    for (const path of paths) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
      ) as {
        dependencies?: Record<string, string>;
      };
      const dependencies = Object.entries(manifest.dependencies ?? {});
      expect(dependencies.length, `${path} should only link workspace packages`).toBeLessThan(
        allowed.size,
      );
      for (const [name, spec] of dependencies) {
        expect(allowed.has(name), `${path} depends on non-workspace package ${name}`).toBe(true);
        expect(spec, `${path} must link ${name} via workspace:*`).toBe('workspace:*');
      }
    }
  });

  it('importing the workspace packages opens no TCP or UDP sockets', () => {
    expect(process.getActiveResourcesInfo().filter((r) => /^(TCP|UDP)/.test(r))).toEqual([]);
  });
});
