// ALPHABOT backend config — ported from the frontend desk.
// Paper money only. Values mirror DEFAULT_CONFIG (v3.6 scalp retune).
// Server owns the config; a few knobs are env-overridable.

export const DEFAULT_CONFIG = {
  bankrollSol: 5,   // v3.8: bankroll denominated in SOL (user's call) — USD value set at portfolio creation from live SOL price
  bankroll0: 1000,  // legacy USD fallback (only used if bankrollSol is unset)
  minTokenScore: 65,
  minLiquidityUsd: 2000,   // was 3000 — on-curve liquidity reads low for young coins
  minVol24hUsd: 5000,      // was 10000 — "with volume" for a young coin is lower
  pumpMinMc: 5000,
  pumpMaxMc: 1000000,   // user's spec: scan under $1M — hard ceiling
  minMc: 50000,
  maxMc: 1000000,      // user's spec: scan under $1M — hard ceiling (was $30M)
  // v3.9: kill chain retuned for the NEW-COIN game (20k–1M MC pump.fun coins
  // with volume). The old filters were built for safe graduated coins and
  // killed every newborn — exactly the universe the user trades.
  minAgeMin: 2,          // was 5 — newborns are the trade
  maxPumpAgeHrs: 48,
  maxAgeDays: 7,
  minBuys24h: 5,         // was 10 — young coins have fewer buys
  requireSells: true,
  maxDevPct: 25,
  minHolders: 10,        // was 25 — a 3-minute-old coin has ~10 holders
  maxTopHolderPct: 35,
  maxTop10Pct: 70,
  eliteBoost: 8,
  // --- TRADE (paper risk engine, v3.6 scalp retune) ---
  // v3.9: user's sizing — NO small trades. Minimum 1 SOL per entry.
  // 65–74 → 1.0 SOL · 75–84 → 1.5 SOL · 85+ → 2.0 SOL.
  // Early (<$100k + 80+) → 1.5 SOL · Whale ($500k–$1M + turnover) → 2.5 SOL.
  maxPositions: 5,
  solSizeBase: 1.0,
  solSizeMid: 1.5,
  solSizeTop: 2.0,
  whaleMcUsd: 500000,
  whaleTurnoverMin: 1.0,
  whaleSolSize: 2.5,
  // Early-ape: under $100k MC + score ≥ 80 → 1.5 SOL conviction size.
  earlyMcUsd: 100000,
  earlyMinScore: 80,
  earlySolSize: 1.5,
  takeProfit: 0.30,
  stopLoss: 0.15,
  trailingStop: 0.12,
  trailingArmAt: 0.10,
  maxHoldHours: 1.5,
  cooldownMin: 30,
  slippage: 0.05,
  // --- LOOP ---
  scanIntervalSec: 45,
  priceIntervalSec: 20,
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
  };
}
