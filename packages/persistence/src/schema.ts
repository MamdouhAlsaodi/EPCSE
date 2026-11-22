import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const runs = pgTable('runs', {
  runId: uuid('run_id').primaryKey().defaultRandom(),
  worldId: text('world_id').notNull(),
  status: text('status').notNull(),
  seed: integer('seed').notNull(),
  baseSnapshotId: uuid('base_snapshot_id'),
  parentRunId: uuid('parent_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const snapshots = pgTable('snapshots', {
  snapshotId: uuid('snapshot_id').primaryKey().defaultRandom(),
  worldId: text('world_id').notNull(),
  runId: uuid('run_id'),
  tick: integer('tick').notNull(),
  payload: text('payload').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  versions: jsonb('versions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const snapshotProvenance = pgTable('snapshot_provenance', {
  snapshotId: uuid('snapshot_id').primaryKey(),
  worldId: text('world_id').notNull(),
  runId: uuid('run_id'),
  tick: integer('tick').notNull(),
  writerId: text('writer_id').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  nonce: text('nonce').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  versions: jsonb('versions').notNull(),
  hmac: text('hmac').notNull(),
});

export const runCommands = pgTable('run_commands', {
  runId: uuid('run_id').notNull(),
  seq: integer('seq').notNull(),
  commandId: text('command_id').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
