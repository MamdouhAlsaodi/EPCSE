export const PHASES = Object.freeze([
  'commands',
  'infrastructure',
  'workforce',
  'production',
  'market',
  'settlement',
  'population',
  'government',
  'logistics',
  'publish',
] as const);
export type PhaseName = (typeof PHASES)[number];
