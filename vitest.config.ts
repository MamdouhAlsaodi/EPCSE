import os from 'node:os';
import { defineConfig } from 'vitest/config';

// Engine-heavy integration suites drive multi-minute fixture runs inside child
// processes. On 2-core CI runners the default worker pool still oversubscribes
// CPU: long-running children block their worker's birpc heartbeats and vitest
// reports "Timeout calling onTaskUpdate" unhandled errors that poison the exit
// code even when every test passes (observed: 391/391 green + 4-8 RPC errors).
// Cap concurrency to the machine's core count minus one headroom core; pool
// stays default. Locally (12 threads) this slightly serializes heavy files —
// acceptable for a deterministic simulation repo.
export default defineConfig({
  test: {
    poolOptions: {
      threads: {
        maxThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
        minThreads: 1,
      },
    },
  },
});
