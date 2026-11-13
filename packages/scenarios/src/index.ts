import { engineStatus } from '@epcse/simulation-core';

/** Bootstrap stub: scenarios are not implemented yet. */
export const scenarioStatus = {
  implemented: false,
  core: '@epcse/simulation-core',
  coreImplemented: engineStatus.implemented,
} as const;
