// src/lib/movers.js — movers strategy (v3.46 rewrite)
//
// Fixes vs v3.23:
//  1. History is TIME-based, not count-based. The old code kept the last 12
//     snapshots and demanded 10+ minutes of history — but snapshots arrive every
//     scan cycle (30s), so 12 of them span ~5.5 min and getMovers() could never
//     return anything. Now we keep HISTORY_MS of history regardless of cadence.
//  2. Snapshots are recorded from DexScreener-enriched data (real mc + volume),
//     not from pump.fun /coins rows, which carry no volume (and no
//     `usd_market_cap` key after normalisation) — so volume was always 0 and the
//     `avgVol > 5000` gate always failed.
//  3. New 'pop' setup: a fast detector for the vertical move (e.g. +40% in 5 min)
//     that shows up as a movers-tab runner. The 30-minute-window detectors can
//     never fire on a coin that goes flat → vertical inside a few minutes.

const snapshots = new Map(); // mint -> { symbol, history: [{mc, ts, vol24h, volH1, volM5}] }
const HISTORY_MS = 90 * 60 * 1000;   // keep 90 min of snapshots per mint
const HISTORY_MAX = 400;             // hard cap per mint (10s ticks × 90 min = 540 → thin below)
const STALE_MS = 2 * 3600e3;
const MIN_HISTORY_MS = 90 * 1000;    // need 90s of history before judging (was 10 min)
const MIN_SNAPSHOTS = 3;

// Tunables (exported so config/tuning can override later)
export const MOVER_CFG = {
  swingWindowMs: 30 * 60 * 1000,  // dip/breakout/momentum look-back
  popWindowMs: 5 * 60 * 1000,     // pop look-back
  popGainPct: 35,                 // +35% inside popWindowMs
  popMinMc: 15000,                // ignore dust
  minAvgVol24h: 5000,
  minVolH1ForPop: 3000,           // real trading in the last hour
};

export function recordMoverSnapshot(coins) {
  const now = Date.now();
  for (const c of coins) {
    if (!c.address || !c.mc || c.mc <= 0) continue;
    let e = snapshots.get(c.address);
    if (!e) e = { history: [], symbol: c.symbol };
    const last = e.history[e.history.length - 1];
    // De-dupe: two writers (scan + hot tick) can land within a second.
    if (last && now - last.ts < 4000) {
      last.mc = c.mc; last.vol24h = c.vol24h || last.vol24h;
      last.volH1 = c.volH1 ?? last.volH1; last.volM5 = c.volM5 ?? last.volM5;
    } else {
      e.history.push({ mc: c.mc, ts: now, vol24h: c.vol24h || 0, volH1: c.volH1 ?? null, volM5: c.volM5 ?? null });
    }
    while (e.history.length && now - e.history[0].ts > HISTORY_MS) e.history.shift();
    while (e.history.length > HISTORY_MAX) e.history.shift();
    e.symbol = c.symbol || e.symbol;
    e.lastMc = c.mc;
    snapshots.set(c.address, e);
  }
  for (const [mint, e] of snapshots) {
    const last = e.history[e.history.length - 1];
    if (!last || now - last.ts > STALE_MS) snapshots.delete(mint);
  }
}

// Oldest snapshot at or after (now - windowMs); falls back to the oldest we have.
function windowStart(h, latestTs, windowMs) {
  for (let i = 0; i < h.length; i++) if (latestTs - h[i].ts <= windowMs) return h[i];
  return h[0];
}

export function getMovers(now = Date.now()) {
  const C = MOVER_CFG;
  const out = [];
  for (const [mint, e] of snapshots) {
    const h = e.history;
    if (h.length < MIN_SNAPSHOTS) continue;
    const latest = h[h.length - 1];
    if (now - latest.ts > 3 * 60 * 1000) continue;       // stale — not live right now
    const span = latest.ts - h[0].ts;
    if (span < MIN_HISTORY_MS) continue;

    // --- long window (dip / breakout / momentum), same semantics as before
    const longStart = windowStart(h, latest.ts, C.swingWindowMs);
    const inLong = h.filter(x => x.ts >= longStart.ts);
    const changePct = ((latest.mc - longStart.mc) / longStart.mc) * 100;
    const peak = Math.max(...inLong.map(x => x.mc));
    const dipFromPeak = ((peak - latest.mc) / peak) * 100;
    const avgVol = inLong.reduce((a, x) => a + (x.vol24h || 0), 0) / inLong.length;
    const isNewHigh = latest.mc >= peak * 0.98;
    const prev = h[h.length - 2];
    const recentGain = prev && prev.mc > 0 ? ((latest.mc - prev.mc) / prev.mc) * 100 : 0;

    // --- short window (pop)
    const popStart = windowStart(h, latest.ts, C.popWindowMs);
    const popPct = popStart.mc > 0 ? ((latest.mc - popStart.mc) / popStart.mc) * 100 : 0;
    const volH1 = latest.volH1 != null ? latest.volH1 : latest.vol24h;

    let setup = null;
    if (popPct >= C.popGainPct && latest.mc >= C.popMinMc && volH1 >= C.minVolH1ForPop) {
      setup = 'pop';
    } else if (changePct >= 30 && avgVol > C.minAvgVol24h) {
      if (dipFromPeak >= 15 && dipFromPeak <= 40 && avgVol > 10000) setup = 'dip';
      else if (isNewHigh && recentGain > 5) setup = 'breakout';
      else if (dipFromPeak < 15) setup = 'momentum';
    }
    if (setup) {
      out.push({
        mint, symbol: e.symbol, setup,
        changePct: Math.round(setup === 'pop' ? popPct : changePct),
        dipFromPeak: Math.round(dipFromPeak),
        mc: latest.mc, avgVol: Math.round(avgVol),
      });
    }
  }
  // pops first (they're the time-critical ones), then by size of move
  out.sort((a, b) => ((b.setup === 'pop') - (a.setup === 'pop')) || (b.changePct - a.changePct));
  return out.slice(0, 20);
}

// Mints worth re-polling on the fast tick: recently active, biggest first.
export function getWatchlist(limit = 80) {
  const now = Date.now();
  const rows = [];
  for (const [mint, e] of snapshots) {
    const last = e.history[e.history.length - 1];
    if (!last || now - last.ts > 20 * 60 * 1000) continue;
    const first = e.history[0];
    const move = first && first.mc > 0 ? Math.abs(last.mc - first.mc) / first.mc : 0;
    rows.push({ mint, score: (last.volH1 || last.vol24h || 0) * (1 + move) });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit).map(r => r.mint);
}

export function moverCount() {
  return snapshots.size;
}

// v3.32: expose raw MC history for the TA entry filter (ta.js).
// Returns [{mc, ts}] oldest→newest, or null if insufficient history.
export function getPriceHistory(mint) {
  const e = snapshots.get(mint);
  if (!e || !e.history || e.history.length < 4) return null;
  return e.history.map(h => ({ mc: h.mc, ts: h.ts }));
}

// test hook
export function _reset() { snapshots.clear(); }
