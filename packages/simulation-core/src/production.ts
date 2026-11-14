import type { Inventory, ProductionRecipe } from './inventory.js';
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
): RecipeProducer {
  let status: RecipeProducerSnapshot['status'] = 'running';
  let stoppedReason: RecipeProducerSnapshot['stoppedReason'];
  let batchesProduced = 0;

  world.registerTickSystem(`production:${producerId}`, () => {
    if (status === 'stopped') return;
    try {
      inventory.produce(ownerId, recipe, 1);
      batchesProduced++;
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
