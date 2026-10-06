// src/lib/events.js — server-side event bus (replaces the frontend floorBus).
// Subscribers get live events; every event also lands in a ring buffer and
// the important ones persist to ab_activity_log (when a DB is present).
import { pool, hasDb } from '../db/pool.js';

const listeners = new Set();
const ring = [];
const RING_CAP = 300;

const PERSIST_KINDS = new Set([
  'trade.enter', 'risk.exit', 'vet.kill', 'vet.scored',
  'research.done', 'judge.done', 'hunt.done', 'callout.hit',
]);

export function subscribeEvents(cb) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function recentEvents(limit = 80) {
  return ring.slice(-limit).reverse();
}

export function emitEvent(kind, payload = {}) {
  const ev = { kind, ts: Date.now(), ...(payload || {}) };
  ring.push(ev);
  if (ring.length > RING_CAP) ring.shift();
  for (const cb of listeners) {
    try { cb(ev); } catch { /* subscriber is a nicety */ }
  }
  if (hasDb && PERSIST_KINDS.has(kind)) {
    const { mint = null, symbol = null, ...detail } = payload;
    pool.query(
      'INSERT INTO ab_activity_log (kind, mint, symbol, detail) VALUES ($1, $2, $3, $4::jsonb)',
      [kind, mint, symbol, JSON.stringify(detail).slice(0, 4000)]
    ).catch(() => {});
    // Prune: keep the last ~2000 rows.
    pool.query(
      'DELETE FROM ab_activity_log WHERE id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM ab_activity_log ORDER BY id DESC LIMIT 2000) s)'
    ).catch(() => {});
  }
}

// Alias kept for ported modules that called floorEmit.
export const floorEmit = emitEvent;
