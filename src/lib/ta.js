// src/lib/ta.js — basic support/resistance entry filter (v3.32).
// User: "memecoins are volatile but sometimes it does follow resistance/support
// even if just for a few seconds." After a -24% loss buying Justice For
// Alcebiades at $7.8K right into a $9K local high.
//
// Simple by design — this is a filter, not a full TA system. Uses the movers
// snapshot MC history (recorded every scan cycle) to find the recent swing
// high (resistance) and swing low (support):
//   - Within 3% below recent swing high → REJECT ("buying into resistance")
//   - Near recent swing low + bouncing → BOOST +5 ("support bounce entry")
//   - Otherwise → NEUTRAL (no adjustment)
// Fail-open: insufficient history = skip (no penalty, no boost).

import { getPriceHistory } from './movers.js';

const RESISTANCE_ZONE_PCT = 0.03; // within 3% of swing high = resistance
const SUPPORT_ZONE_PCT = 0.05;    // within 5% of swing low = support zone
const RESISTANCE_PENALTY = -15;   // score penalty (usually gates the entry)
const SUPPORT_BOOST = 5;          // score boost for support bounces

export function taEntryCheck(mint, currentMc) {
  if (!mint || !(currentMc > 0)) {
    return { decision: 'skip', reason: 'no price data for TA', adjustment: 0 };
  }
  const history = getPriceHistory(mint);
  if (!history || history.length < 4) {
    return { decision: 'skip', reason: 'insufficient price history for TA', adjustment: 0, historyPoints: history ? history.length : 0 };
  }
  const mcs = history.map(h => h.mc).filter(mc => mc > 0);
  if (mcs.length < 4) {
    return { decision: 'skip', reason: 'insufficient price history for TA', adjustment: 0, historyPoints: mcs.length };
  }

  const swingHigh = Math.max(...mcs);
  const swingLow = Math.min(...mcs);
  if (!(swingHigh > swingLow) || !(swingHigh > 0)) {
    return { decision: 'skip', reason: 'flat price history', adjustment: 0 };
  }

  // --- High-launch reject: don't buy coins that spawned at 300K+ ---
  // If the earliest observed MC is already 250K+, there was no 10-20K entry.
  // These are late-stage launches with no edge — skip them.
  const launchMc = mcs[0];
  if (launchMc >= 250000) {
    return {
      decision: 'reject',
      reason: `high launch — spawned at $${Math.round(launchMc)} (no early entry)`,
      adjustment: RESISTANCE_PENALTY,
      swingHigh: Math.round(swingHigh),
      swingLow: Math.round(swingLow),
      historyPoints: mcs.length,
    };
  }

  // --- Resistance: don't buy into the ceiling ---
  // Current MC within 3% below the recent swing high = buying the top.
  const distFromHigh = (swingHigh - currentMc) / swingHigh;
  if (distFromHigh >= 0 && distFromHigh <= RESISTANCE_ZONE_PCT) {
    return {
      decision: 'reject',
      reason: `buying into resistance — ${((1 - currentMc / swingHigh) * 100).toFixed(1)}% below $${Math.round(swingHigh)} swing high`,
      adjustment: RESISTANCE_PENALTY,
      swingHigh: Math.round(swingHigh),
      swingLow: Math.round(swingLow),
      historyPoints: mcs.length,
    };
  }

  // --- Support bounce: buying the dip off a held low ---
  // Near the swing low AND the last 3 points are rising (bounce in progress).
  const distFromLow = (currentMc - swingLow) / swingLow;
  const r = mcs.slice(-3);
  const bouncing = r.length === 3 && r[2] > r[1] && r[1] >= r[0] * 0.97;
  if (distFromLow >= 0 && distFromLow <= SUPPORT_ZONE_PCT && bouncing) {
    return {
      decision: 'boost',
      reason: `support bounce off $${Math.round(swingLow)} swing low`,
      adjustment: SUPPORT_BOOST,
      swingHigh: Math.round(swingHigh),
      swingLow: Math.round(swingLow),
      historyPoints: mcs.length,
    };
  }

  return {
    decision: 'neutral',
    reason: 'mid-range, no S/R conflict',
    adjustment: 0,
    swingHigh: Math.round(swingHigh),
    swingLow: Math.round(swingLow),
    historyPoints: mcs.length,
  };
}
