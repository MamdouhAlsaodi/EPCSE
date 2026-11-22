import type { Pool } from 'pg';
import { RunConflictError } from '../errors.js';

export interface RunRecord {
  runId: string;
  worldId: string;
  status: 'active' | 'closed' | 'branched';
  seed: number;
  baseSnapshotId: string | null;
  parentRunId: string | null;
}

export interface CommandRecord {
  seq: number;
  commandId: string;
  payload: unknown;
  receivedAt: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
  );
}

export class RunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * One ACTIVE run per world, enforced by the partial unique index
   * `runs_one_active_per_world` (isolation invariant; T19 counterfactual
   * branches pass parentRunId/baseSnapshotId and close or branch the parent).
   */
  async openRun(
    worldId: string,
    opts: { seed: number; parentRunId?: string; baseSnapshotId?: string },
  ): Promise<RunRecord> {
    // Explicit branching (T19): opening a child run transitions the parent out
    // of 'active' — the one-active-run-per-world partial unique index admits
    // exactly one active run per world. Parent data is never modified.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (opts.parentRunId) {
        const parent = await client.query('SELECT status FROM runs WHERE run_id = $1 FOR UPDATE', [
          opts.parentRunId,
        ]);
        if (!parent.rows[0]) throw new RunConflictError('parent run does not exist');
        await client.query(
          "UPDATE runs SET status = 'branched', updated_at = now() WHERE run_id = $1",
          [opts.parentRunId],
        );
      }
      try {
        const result = await client.query(
          `INSERT INTO runs (world_id, status, seed, base_snapshot_id, parent_run_id)
           VALUES ($1, 'active', $2, $3, $4)
           RETURNING run_id, world_id, status, seed, base_snapshot_id, parent_run_id`,
          [worldId, opts.seed, opts.baseSnapshotId ?? null, opts.parentRunId ?? null],
        );
        await client.query('COMMIT');
        return mapRun(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error))
          throw new RunConflictError(`world ${worldId} already has an active run`);
        throw error;
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async closeRun(runId: string): Promise<void> {
    await this.pool.query(
      "UPDATE runs SET status = 'closed', updated_at = now() WHERE run_id = $1",
      [runId],
    );
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(
      'SELECT run_id, world_id, status, seed, base_snapshot_id, parent_run_id FROM runs WHERE run_id = $1',
      [runId],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  /**
   * Ordered-command log: PRIMARY KEY (run_id, seq) + UNIQUE (run_id, command_id).
   * Replay of the same command within one run is a typed RunConflictError, never
   * silent dedupe. Different runs may reuse the same commandId (isolation).
   */
  async appendCommand(
    runId: string,
    commandId: string,
    payload: unknown,
  ): Promise<{ seq: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seqResult = await client.query(
        'SELECT seq FROM run_commands WHERE run_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE',
        [runId],
      );
      const seq =
        (seqResult.rows[0]?.seq as number | undefined) === undefined
          ? 1
          : (seqResult.rows[0]!.seq as number) + 1;
      try {
        await client.query(
          'INSERT INTO run_commands (run_id, seq, command_id, payload) VALUES ($1, $2, $3, $4)',
          [runId, seq, commandId, JSON.stringify(payload ?? null)],
        );
      } catch (error) {
        if (isUniqueViolation(error))
          throw new RunConflictError(
            `command ${commandId} was already applied to run ${runId}: replay rejected`,
          );
        throw error;
      }
      await client.query('COMMIT');
      return { seq };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listCommands(runId: string): Promise<CommandRecord[]> {
    const result = await this.pool.query(
      'SELECT run_id, seq, command_id, payload, received_at FROM run_commands WHERE run_id = $1 ORDER BY seq ASC',
      [runId],
    );
    return result.rows
      .map((row) => ({
        runId: row.run_id as string,
        seq: row.seq as number,
        commandId: row.command_id as string,
        payload: row.payload,
        receivedAt: (row.received_at as Date).toISOString(),
      }))
      .map(({ runId: _r, ...rest }) => rest);
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    runId: row.run_id as string,
    worldId: row.world_id as string,
    status: row.status as RunRecord['status'],
    seed: row.seed as number,
    baseSnapshotId: (row.base_snapshot_id as string | null) ?? null,
    parentRunId: (row.parent_run_id as string | null) ?? null,
  };
}

export function createRunRepository(pool: Pool): RunRepository {
  return new RunRepository(pool);
}
