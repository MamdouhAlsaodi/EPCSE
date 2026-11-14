import { validateProductionRecipe, type Inventory, type ProductionRecipe } from './inventory.js';
import type { World } from './world.js';

export interface RecipeProducerSnapshot {
  readonly status: 'running' | 'stopped';
  readonly batchesProduced: number;
  readonly stoppedReason?: 'missing-inputs';
}

export interface RecipeProducer {
  getState(): RecipeProducerSnapshot;
}

export function createRecipeProducer(
  world: World,
  producerId: string,
  inventory: Inventory,
  ownerId: string,
  recipe: ProductionRecipe,
  options: { readonly maxBatchesPerTick?: number } = {},
): RecipeProducer {
  const maxBatchesPerTick = options.maxBatchesPerTick ?? 1;
  if (!Number.isSafeInteger(maxBatchesPerTick) || maxBatchesPerTick <= 0) {
    throw new RangeError('maximum batches per tick must be a positive safe integer');
  }
  let status: RecipeProducerSnapshot['status'] = 'running';
  let stoppedReason: RecipeProducerSnapshot['stoppedReason'];
  let batchesProduced = 0;

  world.registerTickSystem(`production:${producerId}`, () => {
    if (status === 'stopped') return;
    try {
      const { inputs, outputs } = validateProductionRecipe(ownerId, recipe, 1, inventory.hasOwner);
      let feasibleBatches = maxBatchesPerTick;
      const balances = inventory.getState().balances;
      for (const [commodity, quantity] of inputs) {
        const available =
          balances.find((balance) => balance.ownerId === ownerId && balance.commodity === commodity)
            ?.quantity ?? 0;
        feasibleBatches = Math.min(feasibleBatches, Number(BigInt(available) / BigInt(quantity)));
      }
      if (feasibleBatches === 0) {
        status = 'stopped';
        stoppedReason = 'missing-inputs';
        return;
      }
      for (const [commodity, quantity] of outputs) {
        const current =
          balances.find((balance) => balance.ownerId === ownerId && balance.commodity === commodity)
            ?.quantity ?? 0;
        const inputQuantity = inputs.get(commodity) ?? 0;
        const netOutput = BigInt(quantity) - BigInt(inputQuantity);
        if (netOutput > 0n) {
          const outputHeadroom = BigInt(Number.MAX_SAFE_INTEGER) - BigInt(current);
          feasibleBatches = Math.min(feasibleBatches, Number(outputHeadroom / netOutput));
        }
      }
      if (feasibleBatches === 0) {
        throw new RangeError('production inventory would exceed Number.MAX_SAFE_INTEGER');
      }
      if (batchesProduced > Number.MAX_SAFE_INTEGER - feasibleBatches) {
        throw new RangeError('batches produced would exceed Number.MAX_SAFE_INTEGER');
      }
      inventory.produce(ownerId, recipe, feasibleBatches);
      batchesProduced += feasibleBatches;
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message === 'insufficient inventory for production'
      ) {
        status = 'stopped';
        stoppedReason = 'missing-inputs';
        return;
      }
      throw error;
    }
  });

  return {
    getState: () => ({
      status,
      batchesProduced,
      ...(stoppedReason === undefined ? {} : { stoppedReason }),
    }),
  };
}
