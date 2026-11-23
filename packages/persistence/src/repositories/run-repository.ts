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
   * One active PRIMARY run per world (parent_run_id IS NULL), enforced by the
   * partial unique index `runs_one_active_per_world` (0002). Branch runs
   * (parentRunId + baseSnapshotId, T19 counterfactual) are exempt from that
   * single-primary invariant: multiple sibling branches of one parent may be
   * concurrently active in the same world. Every branch open validates inside
   * the parent-lock transaction that (a) the parent exists and is not closed,
   * and (b) the base snapshot exists, belongs to the SAME world, and was
   * written by the parent run — foreign parent/base pairings are rejected
   * (including a parent run that lives in a DIFFERENT world: the parent lock
   * reads both status and world_id, and the locked parent's world must equal
   * the requested worldId). Parent transition + branch insert commit
   * atomically.
   *
   * NOTE: openRun is NOT standalone proof of authenticated data. Branch bases
   * must be consumed only via SnapshotRepository.loadSnapshot, which performs
   * full HMAC verification; untrusted snapshot import is never allowed.
   */
  async openRun(
    worldId: string,
    opts: { seed: number; parentRunId?: string; baseSnapshotId?: string },
  ): Promise<RunRecord> {
    // Explicit branching (T19): opening a child run transitions the parent out
    // of 'active' — the one-active-PRIMARY-run-per-world partial unique index
    // (0002) admits exactly one active primary run per world, while multiple
    // ACTIVE sibling branches of the same parent are allowed. Parent data is
    // never modified.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (opts.parentRunId) {
        if (!opts.baseSnapshotId)
          throw new RunConflictError('branching requires both parentRunId and baseSnapshotId');
        // Lock selects BOTH status and world_id: a run id alone is not proof
        // of world membership. A forged cross-world pairing (parent run from
        // another world) must be rejected before any transition is staged.
        const parent = await client.query(
          'SELECT status, world_id FROM runs WHERE run_id = $1 FOR UPDATE',
          [opts.parentRunId],
        );
        if (!parent.rows[0]) throw new RunConflictError('parent run does not exist');
        if (parent.rows[0].world_id !== worldId)
          throw new RunConflictError(
            `parent run ${opts.parentRunId} belongs to world ${parent.rows[0].world_id}, not ${worldId}`,
          );
        if (parent.rows[0].status === 'closed')
          throw new RunConflictError(
            `parent run ${opts.parentRunId} is closed and cannot be branched`,
          );
        // Reject foreign base snapshots: the fork base must be a snapshot of
        // THIS world, written by THIS parent run (world/ownership integrity).
        const base = await client.query(
          'SELECT world_id, run_id FROM snapshots WHERE snapshot_id = $1 FOR UPDATE',
          [opts.baseSnapshotId],
        );
        if (!base.rows[0] || base.rows[0].world_id !== worldId)
          throw new RunConflictError(
            `base snapshot ${opts.baseSnapshotId} does not belong to world ${worldId}`,
          );
        if (base.rows[0].run_id !== opts.parentRunId)
          throw new RunConflictError(
            `base snapshot ${opts.baseSnapshotId} was not written by parent run ${opts.parentRunId}`,
          );
        await client.query(
          "UPDATE runs SET status = 'branched', updated_at = now() WHERE run_id = $1",
          [opts.parentRunId],
        );
      } else if (opts.baseSnapshotId) {
        throw new RunConflictError('baseSnapshotId without parentRunId is not a valid run opening');
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
          throw new RunConflictError(`world ${worldId} already has an active primary run`);
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
