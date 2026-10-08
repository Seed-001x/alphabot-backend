// ALPHABOT backend config — ported from the frontend desk.
// Paper money only. Values mirror DEFAULT_CONFIG (v3.6 scalp retune).
// Server owns the config; a few knobs are env-overridable.

export const DEFAULT_CONFIG = {
  bankrollSol: 1.0,   // v3.19: 1 SOL book (user's call 2026-10-06) — fresh start, learning intact
  bankroll0: 1000,  // legacy USD fallback (only used if bankrollSol is unset)
  minTokenScore: 50,   // v3.15: more balls — was 55
  aggressiveMode: false,  // v3.18: AGGRESSIVE MODE toggle — continuous in-and-out trading
  // Aggressive overrides (applied when aggressiveMode is on):
  // - score bar 50 → 25 (much wider net, more entries)
  // - MC floor $8k → $5k (catch them even earlier)
  // - cooldown 30 → 5 min (refill slots faster)
  // - ignition +8 → +15, momentum weight boosted (prioritize runners)
  // v3.19: rug shield STAYS ON in aggressive mode — the v3.18 wipeout proved
  // the filters were load-bearing. Disciplined aggro: fast + sized, not blind.
  minLiquidityUsd: 2000,   // graduated coins only (on-curve skips this — curve IS liquidity)
  minVol24hUsd: 2500,      // v3.10: wider net — was 5000
  pumpMinMc: 5000,      // v3.18: catch volume plays earlier
  // a coin at $5k+ already proved it has buyers; never kill for being young
  pumpMaxMc: 500000,   // v3.19: $100k–$500k tier — post-bond runners live here
  minMc: 50000,
  maxMc: 500000,      // v3.19: $500k ceiling — quick 10–20% scalps on bonded coins
  // v3.9: kill chain retuned for the NEW-COIN game (20k–1M MC pump.fun coins
  // with volume). NO minimum age — newborns are vetted on merit (MC, volume,
  // holders, buys), never killed for being young.
  minAgeMin: 0,          // disabled — the $20k MC floor does this job
  maxPumpAgeHrs: 48,
  maxAgeDays: 7,
  minBuys24h: 3,         // v3.10: wider net — was 5
  requireSells: true,
  maxDevPct: 25,
  minHolders: 300,         // v3.26: hard floor — enforced as a kill gate, no exceptions
  maxTopHolderPct: 35,
  maxTop10Pct: 70,
  eliteBoost: 8,
  // --- TRADE (paper risk engine, v3.6 scalp retune) ---
  // v3.19: 1 SOL book. Score bands rescaled — every trade a real chunk of book, no dust.
  // 55–74 → 0.10 SOL · 75–84 → 0.15 SOL · 85+ → 0.20 SOL.
  // Volume boost: turnover (vol24h/mc) ≥ volBoostTurnover bumps one size tier —
  // balls in when there's volume.
  maxPositions: 5,
  solSizeBase: 0.05,
  solSizeMid: 0.075,
  solSizeTop: 0.10,
  volBoostTurnover: 2.0,   // v3.19: 24h volume ≥ 2× MC → size up one tier
  // Early-ape: under $100k MC + score ≥ 80 → 0.15 SOL conviction size.
  // (Universe is now sub-$100k, so this overlaps the bands — kept for tuning.)
  earlyMcUsd: 100000,
  earlyMinScore: 80,
  earlySolSize: 0.15,
  takeProfit: 0.20,   // v3.19: start where the exit profiler converged (was 0.30)
  stopLoss: 0.10,    // v3.19: start where the exit profiler converged (was 0.15)
  trailingStop: 0.12,
  trailingArmAt: 0.10,
  maxHoldHours: 1.5,
  cooldownMin: 30,
  slippage: 0.05,
  // --- REAL-ONLY execution (v3.25) ---
  realMaxSizePct: 0.70,        // max 70% of wallet per trade (tunable)
  priorityFeeLamports: 500000, // v3.33: 0.0005 SOL priority fee per tx (user: maximize small wins)
  jitoTipLamports: 1000000,     // v3.25: 0.001 SOL Jito tip on direct buys (dual-route)
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
// v3.19 philosophy: DISCIPLINED aggro. Fast, wide, sized — but the rug shield
// stays on. v3.18's wipeout (68 trades, -98.8%) proved the vetting was
// load-bearing: 46% of entries hit the stop within minutes on dev dumps.
// Speed and size are the weapons now, not blindness.
export const AGGRESSIVE_OVERRIDES = {
  minTokenScore: 25,      // was 50 — ape more, learn faster
  pumpMinMc: 5000,        // was 8000 — catch them earlier
  cooldownMin: 5,         // was 30 — refill slots faster
  // v3.19: NO skips. Rug/dev/mint-freeze/social checks all stay ON.
};
export const AGGRESSIVE_IGNITION_BONUS = 7;  // ignition +8 → +15 total
export const AGGRESSIVE_MOMENTUM_WEIGHT = 25; // was 10 in SCORE_WEIGHTS

export function applyAggressive(cfg, on) {
  cfg.aggressiveMode = !!on;
  if (on) Object.assign(cfg, AGGRESSIVE_OVERRIDES);
  return cfg;
}
