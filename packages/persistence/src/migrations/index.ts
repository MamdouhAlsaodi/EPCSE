import type { Pool } from 'pg';

interface Migration {
  version: string;
  sql: string;
}

/**
 * Hand-written, version-stamped migrations (drizzle-kit generate unavailable).
 * Idempotent-ish: applied once, recorded in schema_migrations, inside a single
 * transaction per migration.
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
];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const migration of MIGRATIONS) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
      migration.version,
    ]);
    if (applied.rowCount && applied.rowCount > 0) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
