// ALPHABOT backend config — ported from the frontend desk.
// Paper money only. Values mirror DEFAULT_CONFIG (v3.6 scalp retune).
// Server owns the config; a few knobs are env-overridable.

export const DEFAULT_CONFIG = {
  bankroll0: 10000,   // v3.8: bigger virtual bankroll for SOL-denominated sizing
  minTokenScore: 65,
  minLiquidityUsd: 3000,
  minVol24hUsd: 10000,
  pumpMinMc: 5000,
  pumpMaxMc: 2000000,
  minMc: 50000,
  maxMc: 30000000,
  minAgeMin: 5,
  maxPumpAgeHrs: 48,
  maxAgeDays: 7,
  minBuys24h: 10,
  requireSells: true,
  maxDevPct: 25,
  minHolders: 25,
  maxTopHolderPct: 35,
  maxTop10Pct: 70,
  eliteBoost: 8,
  // --- TRADE (paper risk engine, v3.6 scalp retune) ---
  maxPositions: 8,
  // v3.8: SOL-denominated sizing, conviction bands + whale-ape rule.
  // 65–74 → 0.2 SOL · 75–84 → 0.35 SOL · 85+ → 0.5 SOL.
  // Whale: MC > $500k + turnover ≥ 1.0 → 2.5 SOL (overrides bands).
  solSizeBase: 0.2,
  solSizeMid: 0.35,
  solSizeTop: 0.5,
  whaleMcUsd: 500000,
  whaleTurnoverMin: 1.0,
  whaleSolSize: 2.5,
  // Early-ape: under $100k MC + score ≥ 80 → 1 SOL conviction size.
  earlyMcUsd: 100000,
  earlyMinScore: 80,
  earlySolSize: 1.0,
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
