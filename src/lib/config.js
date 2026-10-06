// ALPHABOT backend config — ported from the frontend desk.
// Paper money only. Values mirror DEFAULT_CONFIG (v3.6 scalp retune).
// Server owns the config; a few knobs are env-overridable.

export const DEFAULT_CONFIG = {
  bankrollSol: 0.5,   // v3.13: 0.5 SOL book (user's call 2026-10-06) — realistic sizing for 24/7 running
  bankroll0: 1000,  // legacy USD fallback (only used if bankrollSol is unset)
  minTokenScore: 50,   // v3.15: more balls — was 55
  aggressiveMode: false,  // v3.18: AGGRESSIVE MODE toggle — continuous in-and-out trading
  // Aggressive overrides (applied when aggressiveMode is on):
  // - score bar 50 → 30 (much wider net, more entries)
  // - MC floor $8k → $5k (catch them even earlier)
  // - cooldown 30 → 5 min (refill slots faster)
  // - ignition +8 → +15, momentum weight boosted (prioritize runners)
  minLiquidityUsd: 2000,   // graduated coins only (on-curve skips this — curve IS liquidity)
  minVol24hUsd: 2500,      // v3.10: wider net — was 5000
  pumpMinMc: 8000,      // v3.16: catch volume plays earlier — was 20000 (missing sub-$20k movers)
  // a coin at $20k+ already proved it has buyers; never kill for being young
  pumpMaxMc: 100000,   // v3.12: sub-$100k universe — hard ceiling
  minMc: 50000,
  maxMc: 100000,      // v3.12: sub-$100k universe — hard ceiling
  // v3.9: kill chain retuned for the NEW-COIN game (20k–1M MC pump.fun coins
  // with volume). NO minimum age — newborns are vetted on merit (MC, volume,
  // holders, buys), never killed for being young.
  minAgeMin: 0,          // disabled — the $20k MC floor does this job
  maxPumpAgeHrs: 48,
  maxAgeDays: 7,
  minBuys24h: 3,         // v3.10: wider net — was 5
  requireSells: true,
  maxDevPct: 25,
  minHolders: 5,         // v3.10: wider net — was 10
  maxTopHolderPct: 35,
  maxTop10Pct: 70,
  eliteBoost: 8,
  // --- TRADE (paper risk engine, v3.6 scalp retune) ---
  // v3.13: 0.5 SOL book. Score bands rescaled — every trade a real chunk of book, no dust.
  // 55–74 → 0.10 SOL · 75–84 → 0.15 SOL · 85+ → 0.20 SOL.
  maxPositions: 5,
  solSizeBase: 0.10,
  solSizeMid: 0.15,
  solSizeTop: 0.20,
  // Early-ape: under $100k MC + score ≥ 80 → 0.15 SOL conviction size.
  // (Universe is now sub-$100k, so this overlaps the bands — kept for tuning.)
  earlyMcUsd: 100000,
  earlyMinScore: 80,
  earlySolSize: 0.15,
  takeProfit: 0.30,
  stopLoss: 0.15,
  trailingStop: 0.12,
  trailingArmAt: 0.10,
  maxHoldHours: 1.5,
  cooldownMin: 30,
  slippage: 0.05,
  // --- LOOP ---
  scanIntervalSec: 30,   // v3.14: quicker scans (user 2026-10-06) — was 45s
  priceIntervalSec: 15,   // v3.14: quicker ticks — was 20s
};

const num = (v, fb) => {
  const n = Number(v);
  return isFinite(n) ? n : fb;
};

export function loadConfig() {
  const e = process.env;
  return {
    ...DEFAULT_CONFIG,
    bankroll0: num(e.BANKROLL0, DEFAULT_CONFIG.bankroll0),
    minTokenScore: num(e.MIN_TOKEN_SCORE, DEFAULT_CONFIG.minTokenScore),
    scanIntervalSec: num(e.SCAN_INTERVAL_SEC, DEFAULT_CONFIG.scanIntervalSec),
    priceIntervalSec: num(e.PRICE_INTERVAL_SEC, DEFAULT_CONFIG.priceIntervalSec),
    aggressiveMode: e.AGGRESSIVE_MODE === '1' || e.AGGRESSIVE_MODE === 'true',
  };
}

// Aggressive mode overrides — applied on top of the base config when on.
// Philosophy: it's paper money. Let it fall, let it get rugged, let it learn.
// The ONLY kills in aggressive mode are: no price data at all, MC out of range.
// Everything else flows to scoring — the trade journal teaches the rest.
export const AGGRESSIVE_OVERRIDES = {
  minTokenScore: 25,      // was 50 — ape more, learn faster
  pumpMinMc: 5000,        // was 8000 — catch them earlier
  cooldownMin: 5,         // was 30 — refill slots faster
  skipRugKill: true,      // skip dev/top-holder concentration kills — learn from the rugs
  skipSocialCheck: true,  // skip social link requirement — ape first, filter later
  skipMintFreezeKill: true, // even mint/freeze authority — paper money can afford the lesson
};
export const AGGRESSIVE_IGNITION_BONUS = 7;  // ignition +8 → +15 total
export const AGGRESSIVE_MOMENTUM_WEIGHT = 25; // was 10 in SCORE_WEIGHTS

export function applyAggressive(cfg, on) {
  cfg.aggressiveMode = !!on;
  if (on) Object.assign(cfg, AGGRESSIVE_OVERRIDES);
  return cfg;
}
