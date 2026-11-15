export interface EngineConfig {
  /** Stable world identity for command targeting; defaults to 'default'. */
  readonly worldId?: string;
  readonly initialState?: Record<string, unknown>;
}
export interface EngineSnapshot {
  readonly schemaVersion: number;
  readonly engineVersion: number;
  readonly rulesVersion: number;
  readonly canonicalVersion: number;
  readonly phaseVersion: number;
  readonly config: EngineConfig;
  readonly seed: number;
  readonly tick: number;
  readonly rngState: number;
  readonly nextSequence: number;
  readonly nextEventId: number;
  readonly domain: Record<string, unknown>;
  readonly queue: unknown[];
  readonly receipts: unknown[];
  readonly envelopes: unknown[];
  readonly events: unknown[];
}
export interface EngineView {
  readonly tick: number;
  readonly domain: Record<string, unknown>;
  readonly hash: string;
  readonly eventHash: string;
}
