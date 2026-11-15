/**
 * Bootstrap stub: the simulation engine is not implemented yet.
 * This module must stay free of React, HTTP servers, databases and import-time I/O.
 */
export const engineStatus = { implemented: false } as const;

export * from './services/engine.js';
export * from './models/commands.js';
export * from './models/events.js';
export * from './models/world.js';
export * from './services/scheduler.js';
export * from './services/rng.js';
export * from './services/phases.js';
export * from './services/codec.js';
export * from './shared/canonical.js';

export * from './world.js';
export * from './domain.js';
export * from './commodity.js';
export * from './consumption.js';
export * from './inventory.js';
export * from './money.js';
export * from './city-market.js';
export * from './population.js';
export * from './pricing.js';
export * from './market-clearing.js';
export * from './routes.js';
export * from './transactions.js';
export * from './production.js';
