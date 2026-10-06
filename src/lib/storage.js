// src/lib/storage.js — localStorage replacement for the ported pipeline.
// Sync in-memory Map API (getItem/setItem/removeItem) + hydration from the
// ab_kv table on boot and write-through persistence (fire-and-forget).
// Without DATABASE_URL everything simply lives for the process lifetime.
import { pool, hasDb } from '../db/pool.js';

const mem = new Map();
let hydrated = false;

export async function initStorage() {
  if (!hasDb) return;
  try {
    const { rows } = await pool.query('SELECT key, value FROM ab_kv');
    for (const r of rows) {
      try { mem.set(r.key, JSON.stringify(r.value)); } catch { /* skip bad row */ }
    }
    hydrated = true;
    console.log(`[storage] hydrated ${rows.length} kv keys`);
  } catch (e) {
    console.error('[storage] hydration failed (in-memory mode):', e.message);
  }
}

function persist(key) {
  if (!hasDb || !hydrated) return;
  const raw = mem.get(key);
  let value = null;
  try { value = raw == null ? null : JSON.parse(raw); } catch { value = raw; }
  if (value === null) {
    pool.query('DELETE FROM ab_kv WHERE key = $1', [key]).catch(() => {});
  } else {
    pool.query(
      `INSERT INTO ab_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    ).catch(() => {});
  }
}

export const storage = {
  getItem(k) {
    const v = mem.get(k);
    return v == null ? null : v;
  },
  setItem(k, v) {
    mem.set(k, String(v));
    persist(k);
  },
  removeItem(k) {
    mem.delete(k);
    persist(k);
  },
};

// Direct async KV helpers for boot-time state (portfolio, etc.).
export async function kvGetJson(key, fallback = null) {
  if (hasDb && hydrated) {
    try {
      const { rows } = await pool.query('SELECT value FROM ab_kv WHERE key = $1', [key]);
      if (rows.length) return rows[0].value;
    } catch { /* fall through */ }
  }
  const raw = mem.get(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function kvSetJson(key, value) {
  mem.set(key, JSON.stringify(value));
  persist(key);
}
