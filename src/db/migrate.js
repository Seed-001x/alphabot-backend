#!/usr/bin/env node
// src/db/migrate.js — applies schema.sql + ordered migrations, tracked in
// schema_migrations. No-op (exit 0) when DATABASE_URL is not set.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, hasDb } from './pool.js';

const dir = dirname(fileURLToPath(import.meta.url));

if (!hasDb) {
  console.log('[db] no DATABASE_URL — skipping migrations (in-memory mode)');
  process.exit(0);
}

async function ensureMigrationsTable() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
}

async function applyOnce(name, sql) {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  if (rows.length) {
    console.log(`[db] ${name} — already applied, skipping`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    console.log(`[db] ${name} — applied`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

try {
  await ensureMigrationsTable();
  await applyOnce('000_base_schema', readFileSync(join(dir, 'schema.sql'), 'utf8'));
  let files = [];
  try {
    files = readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    await applyOnce(f.replace(/\.sql$/, ''), readFileSync(join(dir, 'migrations', f), 'utf8'));
  }
  console.log('[db] migrations complete');
} catch (err) {
  console.error('[db] migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
