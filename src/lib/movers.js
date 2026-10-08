// src/lib/movers.js — pump.fun movers strategy (v3.23)
// Tracks top coins by MC, identifies movers by MC change, flags dip/breakout setups.
// Runs alongside the snipe strategy — additive, doesn't replace it.

const snapshots = new Map(); // mint -> { mc, ts, history: [{mc, ts}] }
const HISTORY_KEEP = 12; // keep 12 snapshots (~1h at 5min intervals)

export function recordMoverSnapshot(coins) {
  const now = Date.now();
  for (const c of coins) {
    if (!c.address || !c.mc || c.mc <= 0) continue;
    let e = snapshots.get(c.address);
    if (!e) e = { history: [], symbol: c.symbol };
    e.history.push({ mc: c.mc, ts: now, vol24h: c.vol24h || 0 });
    if (e.history.length > HISTORY_KEEP) e.history.shift();
    e.symbol = c.symbol || e.symbol;
    e.lastMc = c.mc;
    snapshots.set(c.address, e);
  }
  // Prune stale (not seen in 2h)
  for (const [mint, e] of snapshots) {
    const last = e.history[e.history.length - 1];
    if (now - last.ts > 2 * 3600e3) snapshots.delete(mint);
  }
}

export function getMovers() {
  const now = Date.now();
  const out = [];
  for (const [mint, e] of snapshots) {
    const h = e.history;
    if (h.length < 3) continue;
    const oldest = h[0];
    const latest = h[h.length - 1];
    const ageMin = (latest.ts - oldest.ts) / 60000;
    if (ageMin < 10) continue; // need 10+ min of history

    const changePct = ((latest.mc - oldest.mc) / oldest.mc) * 100;
    const peak = Math.max(...h.map(x => x.mc));
    const dipFromPeak = ((peak - latest.mc) / peak) * 100;
    const avgVol = h.reduce((a, x) => a + (x.vol24h || 0), 0) / h.length;

    // MOVER: up 30%+ over the window with real volume
    // DIP: was up, now pulled back 15-40% from peak, volume still alive
    // BREAKOUT: making new highs in last 2 snapshots
    const isNewHigh = latest.mc >= peak * 0.98;
    const recentGain = h.length >= 2
      ? ((latest.mc - h[h.length - 2].mc) / h[h.length - 2].mc) * 100 : 0;

    let setup = null;
    if (changePct >= 30 && avgVol > 5000) {
      if (dipFromPeak >= 15 && dipFromPeak <= 40 && avgVol > 10000) {
        setup = 'dip'; // pumped, pulled back, volume alive → buy the dip
      } else if (isNewHigh && recentGain > 5) {
        setup = 'breakout'; // breaking out on momentum
      } else if (dipFromPeak < 15) {
        setup = 'momentum'; // still running
      }
    }
    if (setup) {
      out.push({
        mint, symbol: e.symbol, setup,
        changePct: Math.round(changePct),
        dipFromPeak: Math.round(dipFromPeak),
        mc: latest.mc, avgVol: Math.round(avgVol),
      });
    }
  }
  out.sort((a, b) => b.changePct - a.changePct);
  return out.slice(0, 20);
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
