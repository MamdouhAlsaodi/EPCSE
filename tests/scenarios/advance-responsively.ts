import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

/** Preserve tick ordering while letting Vitest process RPC between simulation ticks. */
export async function advanceResponsively(engine: { run(ticks: number): unknown }, ticks: number) {
  for (let tick = 0; tick < ticks; tick++) {
    engine.run(1);
    await yieldToEventLoop();
  }
}
