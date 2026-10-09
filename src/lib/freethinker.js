// FREE THINKER (v3.22) — per-coin adaptive TP/SL/sizing + discretionary exits.
// The bot reads each coin and decides its own params, instead of applying
// global fixed thresholds. TP/SL are attention levels, not hard triggers.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Compute per-coin TP/SL/size at entry time based on the coin's characteristics.
 * Size is a percentage of current bankroll — scales as the book grows/shrinks.
 * @param {object} t - token with score, mc, vol24h, liquidity, priceChange, etc.
 * @param {object} cfg - global config (provides base ranges)
 * @param {number} bankrollUsd - current bankroll in USD for percentage sizing
 * @returns {object} { tp, sl, solSize, sizePct, reasoning[] }
 */
export function thinkEntry(t, cfg, bankrollUsd) {
  const reasoning = [];
  const score = t.score || 50;
  const spx = cfg.solPrice || 150; // SOL price for conversion

  // --- SIZE: percentage of bankroll, adjusted by conviction + liquidity ---
  // Base percentages: high conviction = bigger bets
  let sizePct;
  if (score >= 85) sizePct = 0.25;      // 25% — elite setup, swing hard
  else if (score >= 75) sizePct = 0.18;  // 18% — solid setup
  else if (score >= 65) sizePct = 0.12;  // 12% — decent setup
  else sizePct = 0.08;                   // 8% — marginal, small bet
  reasoning.push(`score ${score} → base size ${(sizePct * 100).toFixed(0)}% of bankroll`);

  // Liquidity adjustment: can't exit what you can't sell
  const liq = t.liquidity || 0;
  const mc = t.mc || 1;
  const liqRatio = liq / mc;
  if (liqRatio < 0.05) {
    sizePct *= 0.5;
    reasoning.push(`thin liquidity (${(liqRatio * 100).toFixed(1)}% of MC) — halved size`);
  } else if (liqRatio > 0.2) {
    sizePct *= 1.2;
    reasoning.push(`deep liquidity — sized up 20%`);
  }

  // Volume boost: high turnover = real interest = bigger bet
  const turnover = (t.vol24h && mc) ? t.vol24h / mc : 0;
  if (turnover >= 2) {
    sizePct *= 1.25;
    reasoning.push(`high turnover (${turnover.toFixed(1)}x) — sized up 25%`);
  }

  // Clamp: never less than 5%, never more than 30% of bankroll
  sizePct = clamp(sizePct, 0.05, 0.30);

  // Convert to SOL for the engine
  let sizeUsd = (bankrollUsd || 100) * sizePct;
  // v3.25: $2.50 minimum per play (user: fees eat sub-$2 positions alive)
  if (sizeUsd < 2.50) {
    sizeUsd = 2.50;
    reasoning.push(`bumped to $2.50 minimum`);
  }
  let solSize = sizeUsd / spx;
  solSize = Math.round(solSize * 100) / 100;

  reasoning.push(`final: ${(sizePct * 100).toFixed(0)}% of $${Math.round(bankrollUsd || 100)} = $${sizeUsd.toFixed(2)} (${solSize} SOL)`);

  // --- TP: how far can THIS coin run? ---
  // High score + high buy pressure + rising volume = let it run wider
  let tp = cfg.takeProfit; // start from learned base
  const buyPressure = t.buyPressure || 50;

  if (score >= 80 && buyPressure >= 70) {
    tp = Math.max(tp, 2.0); // 200% — strong coin, strong demand (was 150%)
    reasoning.push(`elite setup (score ${score}, BP ${buyPressure}) — TP widened to 200%`);
  } else if (score >= 70) {
    tp = Math.max(tp, 1.5); // 150% (was 100%)
    reasoning.push(`solid setup — TP at 150%`);
  } else {
    tp = Math.max(tp, 1.0); // 100% — hold for 2x minimum, no more 20% scalps (was 50%)
    reasoning.push(`holding for 2x minimum — no scalps`);
  }

  // Volatility adjustment: wild coins need wider TP to be worth the risk
  const vol5m = Math.abs(t.priceChange?.m5 || 0);
  if (vol5m > 20) {
    tp *= 1.5;
    reasoning.push(`high volatility (${vol5m.toFixed(0)}%/5m) — TP widened for the risk`);
  }

  tp = clamp(tp, 1.0, 5.0); // 100% min (2x), 500% max — no more 20-30% scalps
  tp = Math.round(tp * 100) / 100;

  // --- SL: how much noise before the thesis is wrong? ---
  // v3.31: WIDENED per user — only trigger on real dumps, not normal pullbacks.
  // Tight stops were shaking out winners (Memecoins +781% stopped at -1.2% before running to $100K).
  let sl = cfg.stopLoss; // start from learned base

  if (score >= 80) {
    sl = Math.min(sl, 0.15); // 15% — high conviction, some room (was 12%)
    reasoning.push(`high conviction — SL at 15%`);
  } else if (score < 60) {
    sl = Math.max(sl, 0.40); // 40% — low conviction, max room per user
    reasoning.push(`low conviction — SL widened to 40%`);
  }

  if (vol5m > 20) {
    sl = Math.max(sl, 0.40); // volatile coins need max room — don't shake out on noise
    reasoning.push(`volatile — SL widened to 40% to avoid shakeout`);
  }

  sl = clamp(sl, 0.10, 0.40); // 10% min, 40% max per user (was 30%)
  sl = Math.round(sl * 1000) / 1000;

  return { tp, sl, solSize, sizePct, sizeUsd, reasoning };
}

/**
 * Discretionary exit check. Called when price is near TP/SL levels.
 * Instead of auto-selling, evaluates market conditions.
 * @param {object} pos - position with per-coin tp/sl stored
 * @param {object} q - current quote (mc, vol24h, buys/sells, etc.)
 * @param {object} cfg - global config
 * @returns {object|null} { reason, action: 'sell'|'hold' } or null if no attention needed
 */
export function thinkExit(pos, q, cfg) {
  // v3.41: THINKER SELL AUTHORITY REVOKED per user.
  // The AI was selling winners at +5% (neigh) when TP is 2x.
  // "Who tf gave that instruction" — nobody. Removing it.
  // Thinker can only HOLD, never SELL. Mechanical TP/SL/trailing only.
  return null;
  if (!(midMultiple > 0)) return null;
  const pnlPct = (midMultiple - 1) * 100;

  // Use per-coin TP/SL if set, else fall back to config
  const tp = pos.adaptiveTp || cfg.takeProfit;
  const sl = pos.adaptiveSl || cfg.stopLoss;

  const nearTp = midMultiple >= 1 + tp * 0.8; // within 80% of TP
  const nearSl = midMultiple <= 1 - sl * 0.8; // within 80% of SL
  if (!nearTp && !nearSl) return null;

  // --- Gather market intelligence ---
  const b = q.buys24h, s = q.sells24h;
  let flowBullish = null;
  if (b != null && s != null && pos.flowB0 != null) {
    const dB = Math.max(0, b - (pos.flowB0 || 0));
    const dS = Math.max(0, s - (pos.flowS0 || 0));
    if (dB + dS >= 10) flowBullish = dB > dS * 1.2;
  }

  const volNow = q.vol24h || 0;
  const volEntry = pos.entryVol || volNow;
  const volGrowing = volNow > volEntry * 1.2;
  const volDying = volNow < volEntry * 0.5;

  // Momentum: is price accelerating or decelerating?
  const peak = pos.peakMultiple || 1;
  const offPeak = peak > 1 ? (peak - midMultiple) / (peak - 1) : 0; // 0 = at peak, 1 = gave it all back
  const momentumStrong = offPeak < 0.2; // within 20% of peak
  const momentumFading = offPeak > 0.5; // gave back >50% of gains

  // --- THINK near TP ---
  if (nearTp) {
    // Still running strong? Let it ride.
    if (momentumStrong && volGrowing) {
      return { action: 'hold', reason: `near TP (+${pnlPct.toFixed(0)}%) but momentum strong, volume growing — letting it run` };
    }
    if (flowBullish === true && momentumStrong) {
      return { action: 'hold', reason: `near TP, buy flow dominating — holding for more` };
    }
    // Momentum fading or volume dying? Take profit.
    if (momentumFading || volDying || flowBullish === false) {
      return { action: 'sell', reason: `TP zone (+${pnlPct.toFixed(0)}%), momentum fading${volDying ? ', volume dying' : ''}${flowBullish === false ? ', sell flow' : ''} — taking profit` };
    }
    // At or above TP with no clear signal: take it
    if (midMultiple >= 1 + tp) {
      return { action: 'sell', reason: `TP hit +${Math.round(tp * 100)}% (+${pnlPct.toFixed(0)}% actual) — no continuation signal` };
    }
    return { action: 'hold', reason: `approaching TP, no exit signal yet` };
  }

  // --- THINK near SL ---
  if (nearSl) {
    // Shakeout or real breakdown?
    // Low volume dip = shakeout, hold. High volume selling = real, cut.
    if (volDying && flowBullish !== false) {
      return { action: 'hold', reason: `near SL (${pnlPct.toFixed(0)}%) but volume dying, no sell pressure — likely shakeout, holding` };
    }
    if (flowBullish === false && volGrowing) {
      return { action: 'sell', reason: `near SL, heavy sell flow on rising volume — distribution, cutting` };
    }
    // At or below SL: make the call
    if (midMultiple <= 1 - sl) {
      if (flowBullish === true) {
        return { action: 'hold', reason: `at SL but buy flow still dominant — giving it room` };
      }
      return { action: 'sell', reason: `SL hit -${Math.round(sl * 100)}% (${pnlPct.toFixed(0)}% actual) — thesis broken` };
    }
    return { action: 'hold', reason: `approaching SL, no breakdown confirmed` };
  }

  return null;
}
