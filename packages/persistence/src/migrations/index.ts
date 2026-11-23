import type { Pool } from 'pg';

interface Migration {
  version: string;
  sql: string;
}

/**
 * Hand-written, version-stamped migrations (drizzle-kit generate unavailable).
 * Idempotent: each migration is applied at most once, recorded in
 * schema_migrations, inside a single transaction. Concurrent fresh starts are
 * serialized by a TRANSACTION-SCOPED PostgreSQL advisory lock
 * (pg_advisory_xact_lock): the first writer to hold the lock applies pending
 * migrations atomically (DDL + version insert commit together); concurrent
 * callers block until commit, then re-check schema_migrations inside the same
 * lock scope and skip already-applied versions — the version is re-checked
 * AFTER acquiring the lock and immediately BEFORE applying.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: '0001_init',
    sql: `
CREATE TABLE IF NOT EXISTS runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'closed', 'branched')),
  seed integer NOT NULL,
  base_snapshot_id uuid,
  parent_run_id uuid REFERENCES runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_world
  ON runs (world_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  run_id uuid REFERENCES runs(run_id),
  tick integer NOT NULL,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  versions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS snapshot_provenance (
  snapshot_id uuid PRIMARY KEY REFERENCES snapshots(snapshot_id),
  world_id text NOT NULL,
  run_id uuid,
  tick integer NOT NULL,
  writer_id text NOT NULL CHECK (length(writer_id) BETWEEN 1 AND 128),
  payload_sha256 text NOT NULL,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL,
  versions jsonb NOT NULL,
  hmac text NOT NULL
);
CREATE TABLE IF NOT EXISTS run_commands (
  run_id uuid NOT NULL REFERENCES runs(run_id),
  seq integer NOT NULL,
  command_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, command_id)
);`,
  },
  {
    // T19 SC-16: counterfactual fork needs TWO (or more) concurrently-active
    // sibling branch runs in the same world, each identified by
    // parent_run_id + base_snapshot_id. The 0001 partial unique index
    // admitted exactly one ACTIVE run per world, so opening the second
    // sibling raised RunConflictError. We narrow the invariant to its actual
    // purpose — at most one active PRIMARY run per world (parent_run_id IS
    // NULL) — instead of dropping it or bypassing uniqueness. Branch runs
    // keep full command-log and snapshot isolation; primary semantics,
    // ownership, and world/snapshot integrity are unchanged. Existing rows
    // never violate the new index (it is strictly narrower than 0001's).
    version: '0002_sibling_branch_active_runs',
    sql: `
DROP INDEX IF EXISTS runs_one_active_per_world;
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_world
  ON runs (world_id) WHERE status = 'active' AND parent_run_id IS NULL;`,
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock BEFORE even creating the migrations table: concurrent CREATE TABLE
    // IF NOT EXISTS on an empty schema can race on PostgreSQL catalog keys.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'epcse:persistence:schema_migrations',
    ]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    // Every pending version is re-checked under the same transaction-scoped
    // lock; DDL and version insert commit together, or all roll back.
    for (const migration of MIGRATIONS) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
        migration.version,
      ]);
      if (applied.rowCount && applied.rowCount > 0) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
