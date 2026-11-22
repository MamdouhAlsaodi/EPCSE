/**
 * Protected port: durable snapshot / run persistence.
 *
 * TRUST RULE (binding, ADR-06 + "توجيهات ممدوح المعتمدة لمسارات النقل"):
 * - `initialState` and snapshot content are TRUSTED-ONLY. A caller-supplied
 *   snapshot body is NEVER accepted as evidence that a payment occurred.
 *   `restore`/`load` of untrusted content must never be routed through this
 *   port; content may enter storage ONLY via `saveSnapshot` from a trusted
 *   engine instance (`engine.snapshotText()`).
 * - Provenance metadata (writerId, createdAt, nonce, payloadSha256, HMAC)
 *   authenticates the WRITER of a stored snapshot. Structural validation
 *   (versions, canonical-JSON safety, size) is INTEGRITY-ONLY: it never
 *   constitutes payment or identity evidence.
 * - Loading returns `{ text, provenance }`: opaque bytes plus writer
 *   authentication data. The API layer (T18) must derive payment/identity
 *   evidence solely from run command rows and receipts, never from the fact
 *   that a snapshot was stored or loaded.
 *
 * Restore/continue semantics: restoring a snapshot creates or continues a run
 * whose `baseSnapshotId` points at the loaded snapshot. The parent run stays
 * 'active' unless explicitly branched; T19 counterfactual branches call
 * `openRun(worldId, { parentRunId, baseSnapshotId })`.
 */
export interface PersistedProvenance {
  snapshotId: string;
  worldId: string;
  runId: string | null;
  tick: number;
  versions: {
    schema: number;
    engine: number;
    rules: number;
    canonical: number;
    phase: number;
  };
  createdAt: string;
  writerId: string;
  payloadSha256: string;
  nonce: string;
  hmac: string;
}

export interface SnapshotStore {
  saveSnapshot(
    worldId: string,
    snapshotText: string,
    meta: { runId?: string | null; tick: number; writerId: string },
  ): Promise<PersistedProvenance>;
  loadSnapshot(
    worldId: string,
    snapshotId: string,
  ): Promise<{ text: string; provenance: PersistedProvenance }>;
}

export interface RunRecord {
  runId: string;
  worldId: string;
  status: 'active' | 'closed' | 'branched';
  seed: number;
  baseSnapshotId: string | null;
  parentRunId: string | null;
}

export interface RunStore {
  openRun(
    worldId: string,
    opts: { seed: number; parentRunId?: string; baseSnapshotId?: string },
  ): Promise<RunRecord>;
  closeRun(runId: string): Promise<void>;
  appendCommand(runId: string, commandId: string, payload: unknown): Promise<{ seq: number }>;
  listCommands(runId: string): Promise<{ commandId: string; payload: unknown; seq: number }[]>;
  getRun(runId: string): Promise<RunRecord | null>;
}
