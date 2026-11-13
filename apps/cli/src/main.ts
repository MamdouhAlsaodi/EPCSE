#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { scenarioStatus } from '@epcse/scenarios';
import { engineStatus } from '@epcse/simulation-core';

/** Print the bootstrap status. The CLI is a stub: no simulation is implemented. */
export function run(): string[] {
  return [
    'EPCSE CLI - Economic, Political & Civilization Simulation Engine',
    `simulation-core: ${engineStatus.implemented ? 'implemented' : 'no simulation implemented'}`,
    `scenarios: ${scenarioStatus.implemented ? 'implemented' : 'no scenarios implemented'}`,
    'This is a bootstrap stub; no simulation, economics or world rules exist yet.',
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of run()) console.log(line);
}
