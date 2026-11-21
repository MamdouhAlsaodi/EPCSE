#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  runInitialTwoCities,
  runMultiCityRerouteDemo,
  runThreeNations,
  runTwoCityScenario,
  runVerticalSlice,
  verticalSliceSummary,
  scenarioStatus,
  threeNationsSummary,
} from '@epcse/scenarios';
import { engineStatus } from '@epcse/simulation-core';

function runS0(args: readonly string[]): string[] {
  let scenario: string | undefined;
  let seed = 42;
  let ticks = 100;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--scenario' || option === '--seed' || option === '--ticks') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`missing value for ${option}`);
      if (option === '--scenario') scenario = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error(`${option} must be an integer`);
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error(`${option} is out of range`);
        if (option === '--seed') seed = number;
        else ticks = number;
      }
    } else throw new Error(`unknown run option: ${option}`);
  }
  if (seed < 0 || seed > 0xffffffff) throw new Error('--seed must be uint32');
  if (ticks <= 0) throw new Error('--ticks must be positive');
  if (scenario === 'vertical-slice') return verticalSliceSummary(runVerticalSlice({ seed, ticks }));
  if (scenario === 'three-nations-trade-and-politics')
    return threeNationsSummary(runThreeNations({ seed, ticks }));
  if (scenario !== 'initial-two-cities')
    throw new Error('run requires --scenario initial-two-cities or vertical-slice');
  const report = runInitialTwoCities(seed, ticks).report();
  const effects = report.effects.join(', ');
  const priceChanges = report.prices.reduce(
    (count, price, index, all) => count + (index > 0 && price !== all[index - 1] ? 1 : 0),
    0,
  );
  return [
    'EPCSE S0: initial-two-cities (real engine/accounting integration)',
    `Seed ${seed}; ticks ${report.ticks}; cities ${report.cities.join(', ')}; goods ${report.goods.join(', ')}`,
    `Production conversion batches (journal): grain ${report.production.grain}, wood ${report.production.wood}, tools ${report.production.tools}`,
    `Route trade: ${report.trade.departed} departed, ${report.trade.arrived} arrived; first departure ${report.trade.firstDepartureTick}, first arrival ${report.trade.firstArrivalTick}`,
    `Accounting journal effects: ${effects}; price observations ${report.prices.length}, changes ${priceChanges}; grain price ${report.prices[0]} -> ${report.prices.at(-1)}`,
    `Paid journal entries: wood trade ${report.payments.trade} (${report.trade.woodQuantity} wood x ${report.trade.unitPrice} = ${report.trade.paidTotal} coin); wages ${report.payments.wages}; local cohort purchases ${report.payments.localPurchases}; freight ${report.payments.freight}; payment entries total ${report.paymentJournalEntries}`,
    `Money: ${report.money.total}/${report.money.openingTotal}; nonnegative stocks ${report.stock.nonnegative}; nonnegative balances ${report.money.nonnegative}; all arrived wood paid after delivery ${report.trade.arrivalsPaidAfterDelivery}`,
    `Unmet needs: ${JSON.stringify(report.unmetNeeds)}`,
    `State hash: ${report.hashes.state}`,
    `Event hash: ${report.hashes.events}`,
  ];
}

/** Print deterministic reports; the legacy default remains explicitly synthetic. */
export function run(args: readonly string[] = process.argv.slice(2)): string[] {
  if (args[0] === 'run') return runS0(args.slice(1));
  if (args.includes('--reroute-demo')) {
    const report = runMultiCityRerouteDemo();
    return [
      report.title,
      `Cities: ${report.cities.join(', ')}; routes: ${report.routes.join(', ')}`,
      `Shipment ${report.shipment.shipmentId}: ${report.shipment.departureTick} -> ${report.shipment.arrivalTick}, ${report.shipment.status}; delivered at ${report.shipment.deliveredCityId} (original destination ${report.shipment.originalDestinationCityId})`,
      `Payments: initial ${report.payments.initial}, extra ${report.payments.extra}; balances buyer/carrier ${report.balances.buyer}/${report.balances.carrier}`,
      `Destination inventory: ${JSON.stringify(report.destinationInventory)}; conservation: ${JSON.stringify(report.conservation)}`,
      report.disclaimer,
    ];
  }
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
  try {
    for (const line of run()) console.log(line);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
