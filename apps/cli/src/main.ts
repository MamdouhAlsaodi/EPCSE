#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runTwoCityScenario, scenarioStatus } from '@epcse/scenarios';
import { engineStatus } from '@epcse/simulation-core';

/** Print a deterministic scripted demonstration and accurately scoped status. */
export function run(): string[] {
  const report = runTwoCityScenario();
  return [
    'EPCSE CLI - Economic, Political & Civilization Simulation Engine',
    `simulation-core: ${engineStatus.implemented ? 'full engine implemented' : 'full engine not implemented'}`,
    `scenarios: ${scenarioStatus.implemented ? 'limited scripted demonstration available' : 'not implemented'}`,
    `${report.title} (synthetic/provisional)`,
    `Tick ${report.tick}; cities: ${report.cities.map(({ id, population }) => `${id} (${population})`).join(', ')}`,
    `Goods: ${report.goods.join(', ')}; production: ${report.production.quantity} ${report.production.commodity} at ${report.production.cityId}; producer ${report.production.status}${report.production.stoppedReason ? ` (${report.production.stoppedReason})` : ''}`,
    `Trade: ${report.trade.quantity} ${report.trade.commodity} for ${report.trade.total}; buyer/seller balances ${report.trade.balancesAfter.buyer}/${report.trade.balancesAfter.seller}`,
    `Recurring harbor: ${report.recurring.harbor.traded} traded, ${report.recurring.harbor.consumed} consumed, ${report.recurring.harbor.unmet} unmet of ${report.recurring.harbor.demanded}`,
    `Recurring inland: ${report.recurring.inland.traded} traded, ${report.recurring.inland.consumed} consumed, ${report.recurring.inland.unmet} unmet of ${report.recurring.inland.demanded}`,
    `Route ${report.route.routeId}: ${report.shipment.commodity} ${report.shipment.quantity}, ${report.route.travelTicks} ticks; shipment ${report.shipment.departureTick} -> ${report.shipment.arrivalTick}, ${report.shipment.status}`,
    `Final inventory: ${JSON.stringify(report.finalInventory)}`,
    `Final money: ${JSON.stringify(report.finalMoney)}; conservation: ${JSON.stringify(report.conservation)}`,
    report.disclaimer,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of run()) console.log(line);
}
