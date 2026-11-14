import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '@epcse/cli';
import { scenarioStatus } from '@epcse/scenarios';
import { engineStatus } from '@epcse/simulation-core';

describe('bootstrap import contract', () => {
  it('simulation-core imports cleanly and reports an explicit not-implemented status', () => {
    expect(engineStatus).toEqual({ implemented: false });
  });

  it('scenarios imports simulation-core and reports its limited scripted scope', () => {
    expect(scenarioStatus).toEqual({
      implemented: true,
      kind: 'limited-scripted-demonstration',
      core: '@epcse/simulation-core',
      coreImplemented: false,
    });
  });

  it('the CLI reports the scripted demonstration without claiming a full engine', () => {
    const output = run();
    expect(output).toContain('simulation-core: full engine not implemented');
    expect(output).toContain('scenarios: limited scripted demonstration available');
    expect(output).toContain('Two-city scripted demonstration (synthetic/provisional)');
    expect(output).toContain('Tick 100; cities: harbor (120), inland (80)');
    expect(output.at(-1)).toMatch(/not a complete S0 or economic simulation/i);
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
