// v3.30 TOKEN REGISTRY — persistent Postgres-backed token lifecycle tracking.
// A token shouldn't disappear just because it didn't meet entry criteria when
// it first appeared. It might become interesting five minutes later.
//
// Architecture: Postgres (ab_tokens) is the source of truth; an in-memory
// cache is the hot path for the sync vet-gating API. Single process = the
// cache is the only writer, so it's always consistent. Writes are
// fire-and-forget (debounced per mint); boot hydrates from the DB.
//
// Lifecycle: DISCOVERED → TRACKING → WATCHLIST → CANDIDATE → RISK_CHECK →
// ENTRY_READY → POSITION_OPEN, plus REJECTED_TEMPORARY / REJECTED_RISK / STALE.
// Rejection is a recorded decision, not deletion.
//
// Safety: the registry gates WHETHER TO VET, never WHETHER TO TRADE.
// Trading decisions use fresh per-cycle market data. DB failure → fail-open
// (vet everything), never trade on stale data.

import { pool, hasDb } from '../db/pool.js';

const VET_COOLDOWN_MS = 5 * 60 * 1000;
const MC_MOVE_PCT = 20;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;
const DB_WRITE_DEBOUNCE_MS = 60 * 1000;

// In-memory cache: mint -> record. Mirrors ab_tokens for watched tokens.
const reg = new Map();
// Last DB write per mint (debounce).
const lastDbWrite = new Map();
// Set of mints with a queued-but-unflushed DB write.
const dirtyMints = new Set();
let dbFlushTimer = null;
let hydrated = false;
let dbHealthy = true;

// Lifecycle states.
export const LIFECYCLE = {
  DISCOVERED: 'DISCOVERED',
  TRACKING: 'TRACKING',
  WATCHLIST: 'WATCHLIST',
  CANDIDATE: 'CANDIDATE',
  RISK_CHECK: 'RISK_CHECK',
  ENTRY_READY: 'ENTRY_READY',
  POSITION_OPEN: 'POSITION_OPEN',
  REJECTED_TEMPORARY: 'REJECTED_TEMPORARY',
  REJECTED_RISK: 'REJECTED_RISK',
  STALE: 'STALE',
};

// Risk-verdict → lifecycle mapping for vet outcomes.
function verdictToState(verdict, killReason) {
  if (!verdict || verdict === 'SCORED') return LIFECYCLE.CANDIDATE;
  // KILLED: distinguish safety kills (risk) from strategy kills (temporary).
  const r = String(killReason || '').toLowerCase();
  const riskSignals = ['honeypot', 'concentration', 'bundle', 'lp ', 'liquidity lock', 'freeze', 'mint authority', 'unexitable', 'rug'];
  if (riskSignals.some(s => r.includes(s))) return LIFECYCLE.REJECTED_RISK;
  return LIFECYCLE.REJECTED_TEMPORARY;
}

function newRecord(mint, mc) {
  const now = Date.now();
  return {
    mint,
    symbol: null,
    name: null,
    firstSeen: now,
    lastSeen: now,
    sources: [],
    venue: 'bonding_curve',
    state: LIFECYCLE.DISCOVERED,
    lastMc: mc > 0 ? mc : 0,
    lastLiquidityUsd: null,
    lastVol24h: null,
    riskStatus: 'unverified',
    watch: true,
    lastVetTs: 0,
    lastVerdict: null,
    rejectionReason: null,
    nextReevalAt: 0,
    vetCount: 0,
  };
}

// ---------------------------------------------------------- DB write path

function scheduleDbFlush() {
  if (!hasDb || !dbHealthy) return;
  if (dbFlushTimer) return;
  dbFlushTimer = setTimeout(flushDbWrites, 5000);
  // Don't hold the process open for a pending flush.
  if (dbFlushTimer.unref) dbFlushTimer.unref();
}

function markDirty(mint) {
  if (!hasDb) return;
  const now = Date.now();
  const last = lastDbWrite.get(mint) || 0;
  if (now - last < DB_WRITE_DEBOUNCE_MS) {
    // Still record in cache; DB write deferred to the next flush window.
    dirtyMints.add(mint);
    scheduleDbFlush();
    return;
  }
  dirtyMints.add(mint);
  scheduleDbFlush();
}

async function flushDbWrites() {
  dbFlushTimer = null;
  if (!hasDb || !dbHealthy || dirtyMints.size === 0) return;
  const batch = [...dirtyMints];
  dirtyMints.clear();
  const now = Date.now();
  try {
    // Batch upserts in a single transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const mint of batch) {
        const e = reg.get(mint);
        if (!e) continue;
        await client.query(
          `INSERT INTO ab_tokens
             (mint, symbol, name, first_seen, last_seen, discovery_sources, venue,
              lifecycle_state, last_mc, last_liquidity_usd, last_vol24h,
              risk_status, watch, last_evaluated_at, rejection_reason,
              next_reeval_at, vet_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (mint) DO UPDATE SET
             symbol = COALESCE(EXCLUDED.symbol, ab_tokens.symbol),
             name = COALESCE(EXCLUDED.name, ab_tokens.name),
             last_seen = GREATEST(ab_tokens.last_seen, EXCLUDED.last_seen),
             discovery_sources = (
               SELECT ARRAY(SELECT DISTINCT unnest(ab_tokens.discovery_sources || EXCLUDED.discovery_sources))
             ),
             venue = EXCLUDED.venue,
             lifecycle_state = EXCLUDED.lifecycle_state,
             last_mc = COALESCE(EXCLUDED.last_mc, ab_tokens.last_mc),
             last_liquidity_usd = COALESCE(EXCLUDED.last_liquidity_usd, ab_tokens.last_liquidity_usd),
             last_vol24h = COALESCE(EXCLUDED.last_vol24h, ab_tokens.last_vol24h),
             risk_status = EXCLUDED.risk_status,
             watch = EXCLUDED.watch,
             last_evaluated_at = COALESCE(EXCLUDED.last_evaluated_at, ab_tokens.last_evaluated_at),
             rejection_reason = COALESCE(EXCLUDED.rejection_reason, ab_tokens.rejection_reason),
             next_reeval_at = COALESCE(EXCLUDED.next_reeval_at, ab_tokens.next_reeval_at),
             vet_count = GREATEST(ab_tokens.vet_count, EXCLUDED.vet_count),
             updated_at = NOW()`,
          [
            e.mint, e.symbol, e.name,
            new Date(e.firstSeen).toISOString(), new Date(e.lastSeen).toISOString(),
            e.sources, e.venue, e.state,
            e.lastMc || null, e.lastLiquidityUsd, e.lastVol24h,
            e.riskStatus, e.watch,
            e.lastVetTs ? new Date(e.lastVetTs).toISOString() : null,
            e.rejectionReason,
            e.nextReevalAt ? new Date(e.nextReevalAt).toISOString() : null,
            e.vetCount,
          ]
        );
        lastDbWrite.set(mint, now);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[registry] DB write failed (in-memory mode):', err.message);
    dbHealthy = false;
    // Re-mark dirty so a later recovery can retry; re-check health on next flush.
    for (const m of batch) dirtyMints.add(m);
    setTimeout(() => { dbHealthy = true; }, 60000);
    scheduleDbFlush();
  }
  if (dirtyMints.size > 0) scheduleDbFlush();
}

// ---------------------------------------------------------- boot hydration

/** Load watched tokens from Postgres into the in-memory cache. Call once at boot. */
export async function initRegistry() {
  if (!hasDb) {
    console.log('[registry] no DATABASE_URL — in-memory only');
    return { hydrated: false, count: 0 };
  }
  try {
    const { rows } = await pool.query(
      `SELECT mint, symbol, name, first_seen, last_seen, discovery_sources, venue,
              lifecycle_state, last_mc, last_liquidity_usd, last_vol24h,
              risk_status, watch, last_evaluated_at, rejection_reason,
              next_reeval_at, vet_count
       FROM ab_tokens WHERE watch = TRUE`
    );
    for (const r of rows) {
      reg.set(r.mint, {
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        firstSeen: new Date(r.first_seen).getTime(),
        lastSeen: new Date(r.last_seen).getTime(),
        sources: r.discovery_sources || [],
        venue: r.venue || 'bonding_curve',
        state: r.lifecycle_state || LIFECYCLE.DISCOVERED,
        lastMc: Number(r.last_mc) || 0,
        lastLiquidityUsd: r.last_liquidity_usd != null ? Number(r.last_liquidity_usd) : null,
        lastVol24h: r.last_vol24h != null ? Number(r.last_vol24h) : null,
        riskStatus: r.risk_status || 'unverified',
        watch: true,
        lastVetTs: r.last_evaluated_at ? new Date(r.last_evaluated_at).getTime() : 0,
        lastVerdict: null,
        rejectionReason: r.rejection_reason,
        nextReevalAt: r.next_reeval_at ? new Date(r.next_reeval_at).getTime() : 0,
        vetCount: r.vet_count || 0,
      });
    }
    hydrated = true;
    console.log(`[registry] hydrated ${rows.length} tokens from Postgres`);
    return { hydrated: true, count: rows.length };
  } catch (e) {
    console.error('[registry] hydration failed (in-memory mode):', e.message);
    return { hydrated: false, count: 0 };
  }
}

// ---------------------------------------------------------- sync API (unchanged signatures)

/** Record that the scanner saw this mint at this MC. */
export function registryTouch(mint, mc, extra = {}) {
  if (!mint) return;
  const now = Date.now();
  let e = reg.get(mint);
  if (e) {
    e.lastSeen = now;
    if (mc > 0) e.lastMc = mc;
    if (extra.symbol && !e.symbol) e.symbol = extra.symbol;
    if (extra.name && !e.name) e.name = extra.name;
    if (extra.source && !e.sources.includes(extra.source)) e.sources.push(extra.source);
    if (extra.venue) e.venue = extra.venue;
    if (e.state === LIFECYCLE.DISCOVERED) e.state = LIFECYCLE.TRACKING;
  } else {
    e = newRecord(mint, mc);
    e.state = LIFECYCLE.TRACKING;
    if (extra.symbol) e.symbol = extra.symbol;
    if (extra.name) e.name = extra.name;
    if (extra.source) e.sources.push(extra.source);
    if (extra.venue) e.venue = extra.venue;
    reg.set(mint, e);
  }
  markDirty(mint);
  if (reg.size > 20000) {
    // prune oldest lastSeen from cache (DB rows are marked STALE, not deleted)
    let oldest = null, oldestTs = Infinity;
    for (const [k, v] of reg) {
      if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldest = k; }
    }
    if (oldest) {
      const oe = reg.get(oldest);
      if (oe) { oe.watch = false; oe.state = LIFECYCLE.STALE; markDirty(oldest); }
      reg.delete(oldest);
    }
  }
}

/** Should this mint go through the vet kill chain right now? */
export function registryShouldVet(mint, mc) {
  if (!mint) return false;
  const e = reg.get(mint);
  if (!e) return true; // never seen → vet
  if (!e.lastVetTs) return true; // seen but never vetted → vet
  // Risk-rejected: require new evidence (venue change handled by caller
  // resetting lastVetTs; otherwise respect a long cooldown).
  const now = Date.now();
  // MC moved >20% since last vet → runner candidate, re-vet immediately.
  // This also lifts temporary rejections when conditions improve.
  if (e.lastMc > 0 && mc > 0) {
    const movePct = Math.abs(mc - e.lastMc) / e.lastMc * 100;
    if (movePct > MC_MOVE_PCT) return true;
  }
  // Scheduled reevaluation time reached.
  if (e.nextReevalAt && now >= e.nextReevalAt) return true;
  // Risk rejections get a 24h cooldown; temporary rejections get 5 min.
  const cooldown = e.state === LIFECYCLE.REJECTED_RISK ? 24 * 3600 * 1000 : VET_COOLDOWN_MS;
  return (now - e.lastVetTs) >= cooldown;
}

/** Record a vet outcome so future cycles can decide on re-vetting. */
export function registryRecordVet(mint, verdict, mc, opts = {}) {
  if (!mint) return;
  registryTouch(mint, mc, opts);
  const e = reg.get(mint);
  if (e) {
    const now = Date.now();
    e.lastVetTs = now;
    e.vetCount += 1;
    e.lastVerdict = verdict || null;
    const newState = verdictToState(verdict, opts.killReason || e.rejectionReason);
    e.state = newState;
    if (opts.killReason) e.rejectionReason = String(opts.killReason).slice(0, 500);
    if (opts.riskStatus) e.riskStatus = opts.riskStatus;
    // Temporary rejections get a scheduled reevaluation; risk rejections wait for new evidence.
    e.nextReevalAt = newState === LIFECYCLE.REJECTED_TEMPORARY ? now + VET_COOLDOWN_MS : 0;
    markDirty(mint);
    // Fire-and-forget evaluation history row.
    if (hasDb && dbHealthy) {
      const snapshot = {
        mc: mc || null,
        state: newState,
        vetCount: e.vetCount,
      };
      pool.query(
        `INSERT INTO ab_evaluations (mint, market_snapshot, decision, rejection_reason, strategy_version)
         VALUES ($1, $2::jsonb, $3, $4, $5)`,
        [mint, JSON.stringify(snapshot), verdict === 'KILLED' ? 'killed' : 'vetted_pass',
         e.rejectionReason, 'v3.30']
      ).catch(() => {});
    }
  }
}

/** Drop entries not seen in 24h. Call once per scan cycle. */
export function registryPrune() {
  const now = Date.now();
  for (const [k, v] of reg) {
    if (now - v.lastSeen > PRUNE_AFTER_MS) {
      v.watch = false;
      v.state = LIFECYCLE.STALE;
      markDirty(k);
      reg.delete(k);
    }
  }
  // Trim old observations (24h retention).
  if (hasDb && dbHealthy) {
    pool.query(`DELETE FROM ab_token_observations WHERE ts < NOW() - INTERVAL '24 hours'`).catch(() => {});
  }
}

/** For diagnostics: how many tokens tracked. */
export function registrySize() {
  return reg.size;
}

// ---------------------------------------------------------- new async API

// v3.32: attach a TA entry-check decision to the token's most recent
// evaluation record. Fire-and-forget — the TA gate runs at entry time
// (after registryRecordVet), so this patches the snapshot JSON on the
// latest ab_evaluations row for inspectability.
export function registryAttachTa(mint, taCheck) {
  if (!mint || !taCheck || !hasDb || !dbHealthy) return;
  try {
    const ta = {
      decision: taCheck.decision || null,
      reason: (taCheck.reason || '').slice(0, 300),
      adjustment: taCheck.adjustment || 0,
      swingHigh: taCheck.swingHigh || null,
      swingLow: taCheck.swingLow || null,
      historyPoints: taCheck.historyPoints || null,
    };
    pool.query(
      `UPDATE ab_evaluations SET market_snapshot = market_snapshot || $2::jsonb
       WHERE id = (SELECT id FROM ab_evaluations WHERE mint = $1 ORDER BY ts DESC LIMIT 1)`,
      [mint, JSON.stringify({ ta })]
    ).catch(() => {});
  } catch { /* fail-open */ }
}

/** Transition a token's lifecycle state. */
export async function registrySetState(mint, state, reason = null) {
  const e = reg.get(mint);
  if (e) {
    e.state = state;
    if (reason) e.rejectionReason = String(reason).slice(0, 500);
    // Graduation or venue change resets the risk cooldown — new evidence.
    if (state === LIFECYCLE.TRACKING) {
      e.lastVetTs = 0;
      e.nextReevalAt = Date.now();
    }
    markDirty(mint);
  } else if (hasDb && dbHealthy) {
    try {
      await pool.query(
        `UPDATE ab_tokens SET lifecycle_state = $2, rejection_reason = COALESCE($3, rejection_reason),
                updated_at = NOW() WHERE mint = $1`,
        [mint, state, reason]
      );
    } catch (err) {
      console.error('[registry] setState failed:', err.message);
    }
  }
}

/** Update a token's venue (e.g. bonding_curve → pumpswap on graduation). Keeps the same record. */
export async function registrySetVenue(mint, venue) {
  const e = reg.get(mint);
  if (e) {
    if (e.venue !== venue) {
      e.venue = venue;
      // New venue = new evidence: allow re-vetting.
      e.lastVetTs = 0;
      e.nextReevalAt = Date.now();
      if (e.state === LIFECYCLE.REJECTED_RISK || e.state === LIFECYCLE.REJECTED_TEMPORARY) {
        e.state = LIFECYCLE.TRACKING;
      }
      markDirty(mint);
    }
  } else if (hasDb && dbHealthy) {
    try {
      await pool.query(
        `UPDATE ab_tokens SET venue = $2, lifecycle_state = 'TRACKING',
                last_evaluated_at = NULL, next_reeval_at = NOW(), updated_at = NOW()
         WHERE mint = $1`,
        [mint, venue]
      );
    } catch (err) {
      console.error('[registry] setVenue failed:', err.message);
    }
  }
}

/** Full record for diagnostics. */
export function registryGet(mint) {
  return reg.get(mint) || null;
}

/** Record a market observation (for momentum calculation). Fire-and-forget. */
export function registryRecordObservation(mint, metrics = {}) {
  if (!mint || !hasDb || !dbHealthy) return;
  const { mc = null, price = null, vol24h = null, buyVol = null, sellVol = null, txns = null, liquidityUsd = null } = metrics;
  pool.query(
    `INSERT INTO ab_token_observations (mint, mc, price, vol24h, buy_vol, sell_vol, txns, liquidity_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [mint, mc, price, vol24h, buyVol, sellVol, txns, liquidityUsd]
  ).catch(() => {});
}

/** Mints due for reevaluation, oldest first. Used to prioritize re-vets. */
export async function registryDueForReeval(limit = 25) {
  if (!hasDb || !dbHealthy) {
    // Fall back to in-memory scan.
    const now = Date.now();
    const out = [];
    for (const [mint, e] of reg) {
      if (e.watch && e.nextReevalAt && now >= e.nextReevalAt) out.push(mint);
      if (out.length >= limit) break;
    }
    return out;
  }
  try {
    const { rows } = await pool.query(
      `SELECT mint FROM ab_tokens
       WHERE watch = TRUE AND next_reeval_at IS NOT NULL AND next_reeval_at <= NOW()
       ORDER BY next_reeval_at ASC LIMIT $1`,
      [limit]
    );
    return rows.map(r => r.mint);
  } catch (err) {
    console.error('[registry] dueForReeval failed:', err.message);
    return [];
  }
}

/** Flush pending writes immediately (for graceful shutdown / tests). */
export async function registryFlush() {
  if (dbFlushTimer) {
    clearTimeout(dbFlushTimer);
    dbFlushTimer = null;
  }
  await flushDbWrites();
}
