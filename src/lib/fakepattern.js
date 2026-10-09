// src/lib/fakepattern.js — "snipe-and-farm" fake pattern detection (v3.37).
// User-identified repetitive scam pattern (seen 3-4x, the #1 thing killing the bot):
//   1. One vertical candle straight up to ~$400K (dev snipes own launch)
//   2. Then sideways price action (volume bot running, faking activity)
//   3. All buys are tiny identical amounts (0.01/0.02 SOL) — one person with
//      ~5 wallets wash trading back-to-back to look like real volume
//   4. Bots (like ours) buy thinking it's real demand; dev rugs to zero
//
// The tell is the COMBINATION — not either signal alone:
//   chart: >300% gain inside any 5-min window, then <10% range over the
//          next 15 min (spike + farm sideways)
//   txs:   80%+ of buys tiny (<0.05 SOL) and uniform (washtrade.js check)
// Fail-open: insufficient history or Helius error = skip, never block.

import { getPriceHistory } from './movers.js';

const SPIKE_GAIN = 3.0;                 // >300% gain
const SPIKE_WINDOW_MS = 5 * 60 * 1000;  // inside a 5-min window
const FARM_WINDOW_MS = 15 * 60 * 1000;  // 15 min after the peak
const FARM_RANGE = 0.10;                // <10% range = sideways farming
const MIN_POINTS = 4;

function skip(reason) {
  return { isFake: false, confidence: 'low', reason, chart: null, txs: null };
}

// Pure chart-pattern check on [{mc, ts}] oldest→newest.
// Returns { spike, farm } or null. Exported for synthetic testing.
export function analyzeChartPattern(history) {
  const pts = (history || []).filter(p => p && p.mc > 0 && p.ts > 0);
  if (pts.length < MIN_POINTS) return null;

  // 1. Find any 5-min window with a >300% gain.
  let spike = null;
  for (let i = 0; i < pts.length && !spike; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j].ts - pts[i].ts;
      if (dt > SPIKE_WINDOW_MS) break; // history is ts-ordered ascending
      if (dt <= 0) continue;
      if (pts[j].mc / pts[i].mc - 1 > SPIKE_GAIN) {
        let peakIdx = i;
        for (let k = i; k <= j; k++) if (pts[k].mc > pts[peakIdx].mc) peakIdx = k;
        spike = {
          fromIdx: i,
          peakIdx,
          baseMc: pts[i].mc,
          peakMc: pts[peakIdx].mc,
          gainPct: Math.round((pts[peakIdx].mc / pts[i].mc - 1) * 100),
          spikeMin: +((pts[j].ts - pts[i].ts) / 60000).toFixed(1),
          peakTs: pts[peakIdx].ts,
        };
        break;
      }
    }
  }
  if (!spike) return null;

  // 2. Sideways farm: range over the 15 min after the peak.
  const after = pts.filter(p => p.ts > spike.peakTs && p.ts - spike.peakTs <= FARM_WINDOW_MS);
  let farm = null;
  if (after.length >= 2) {
    const mcs = after.map(p => p.mc);
    const lo = Math.min(...mcs), hi = Math.max(...mcs);
    const range = (hi - lo) / lo;
    farm = {
      points: after.length,
      rangePct: +(range * 100).toFixed(1),
      sideways: range < FARM_RANGE,
      windowMin: +((after[after.length - 1].ts - spike.peakTs) / 60000).toFixed(1),
    };
  }
  return { spike, farm };
}

// Full detection: chart gate first (free), tx confirmation only on a chart
// pattern match (saves Helius credits).
export async function detectSnipeAndFarm(mint) {
  if (!mint) return skip('no mint');
  let history = null;
  try { history = getPriceHistory(mint); } catch { /* fail-open */ }
  const pattern = analyzeChartPattern(history);
  if (!pattern) return skip('no snipe-and-farm chart pattern');
  const { spike, farm } = pattern;

  let txs = null;
  try {
    const { checkBuyDistribution } = await import('./washtrade.js');
    txs = await checkBuyDistribution(mint);
  } catch { /* fail-open: tx check unavailable */ }

  const washConfirmed = !!(txs && txs.isWashTrade);
  const sidewaysConfirmed = !!(farm && farm.sideways);
  const chartDesc = `vertical spike +${spike.gainPct}% to $${Math.round(spike.peakMc)}` +
    (farm
      ? (farm.sideways
        ? `, then ${farm.rangePct}% range over ${farm.windowMin}min (farming)`
        : `, then ${farm.rangePct}% range (not sideways)`)
      : ', sideways data pending');

  if (sidewaysConfirmed && washConfirmed) {
    return {
      isFake: true, confidence: 'high',
      reason: `snipe-and-farm: ${chartDesc}; ${txs.reason}`,
      chart: { spike, farm }, txs,
    };
  }
  if (washConfirmed) {
    return {
      isFake: true, confidence: 'medium',
      reason: `spike + wash buys: ${chartDesc}; ${txs.reason}`,
      chart: { spike, farm }, txs,
    };
  }
  if (sidewaysConfirmed) {
    return {
      isFake: true, confidence: 'medium',
      reason: `spike + sideways farm: ${chartDesc} (tx check inconclusive)`,
      chart: { spike, farm }, txs,
    };
  }
  return {
    isFake: false, confidence: 'low',
    reason: `spike without farm/wash confirmation: ${chartDesc}`,
    chart: { spike, farm }, txs,
  };
}
