// src/db/pool.js — Postgres pool. DATABASE_URL is optional: without it the
// backend runs fully in-memory (ledgers live for the process lifetime).
// The user adds DATABASE_URL in the Render dashboard for durability.
import pg from 'pg';

const { Pool } = pg;

export const hasDb = Boolean(process.env.DATABASE_URL);

export const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : null;

if (pool) {
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
}
