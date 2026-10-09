// REALTRADE (v3.25) — REAL-ONLY signal processing. Replaces paper.js
// processResult/tick in the pipeline loop.
//
// The decision logic here is PORTED VERBATIM from paper.js v3.24:
// same score computation (researchMod, eliteBoost, moverBonus, m5EntryPenalty),
// same entry gates (stablecoin, score bar, max positions, already-holding,
// cooldown), same SOL sizing (score bands, volume boost, free-thinker
// adaptive TP/SL/size), same exit logic (liquidity death, thinker, exit
// policy, TP/SL, trailing, max hold, conviction holds, zombie/dead sweepers,
// elite-seller exits).
//
// What changed is ONLY the bookkeeping: entries execute on-chain via
// realbook.realEnter and exits via realbook.realClosePosition. There is no
// paper portfolio, no paper cash, no paper P&L.
//
// Two bug fixes vs paper.js v3.24 (crash bugs, not strategy):
//  - `sig.moverBonus` / `sig.m5Penalty` were assigned BEFORE `const sig`
//    was declared → ReferenceError killed every mover entry and every
//    m5-penalized entry. The scoring math (finalScore) was always correct;
//    only the recording crashed. Fixed by declaring the signal first.

import { STABLE_MINTS } from './helius.js';
import { floorEmit } from './events.js';
import { exitPolicy, getExitRules } from './exits.js';
import { thinkEntry, thinkExit } from './freethinker.js';
import { m5EntryPenalty } from './learning.js';
import { honeypotCheck, moverQualityBonus } from './antiscam.js';
import { fmtUsd, fmtDur } from './fmt.js';
import {
  getRealBook, realEnter, realClosePosition,
} from './realbook.js';

/**
 * Process one vet result. Returns { signal, entered }.
 * KILLED verdicts return early (kill ledger is written by the caller).
 * This is paper.js processResult() with the paper ledger removed.
 */
export async function processSignal(r, cfg, opts = {}) {
  const now = Date.now();
  const t = r.t;
  const base = {
    id: `${t.address}-${Math.floor(now / 1000)}`,
    ts: now, mint: t.address,
    symbol: t.symbol, name: t.name,
    taken: false, reason: '',
  };
  const done = (sig, entered) => ({ signal: sig, entered });

  if (r.verdict === 'KILLED') {
    const sig = { ...base, verdict: 'KILLED', killPass: r.killPass, killReason: r.killReason, reason: `KILLED [${r.killPass}] · ${r.killReason}` };
    return done(sig, false);
  }

  let score = r.score;
  const researchMod = r.researchMod || 0;
  score = Math.max(0, Math.min(100, score + researchMod));
  const boost = r.eliteHit ? cfg.eliteBoost : 0;
  // v3.23: movers setup bonus — dip +12 / breakout +8 / momentum +5.
  let moverBonus = 0;
  if (t.moverSetup === 'dip') moverBonus = 12;
  else if (t.moverSetup === 'breakout') moverBonus = 8;
  else if (t.moverSetup === 'momentum') moverBonus = 5;
  // Learned post-pump fade (movers bypass — proven momentum).
  const m5pen = t.moverSetup ? 0 : m5EntryPenalty(t.priceChange?.m5);
  // v3.26: mover quality bonus — rewards real momentum plays:
  // +10 holders >= 300 · +8 sustained volume 15+ min · +5 gradual MC climb.
  let qualityBonus = 0, qualityLine = '';
  try {
    const qb = moverQualityBonus(t, r.dossier);
    qualityBonus = qb.bonus || 0;
    qualityLine = qb.line || '';
  } catch { /* fail-open */ }
  // v3.32: TA support/resistance filter — don't buy into resistance, prefer
  // support bounces. Uses recent MC swing high/low from movers history.
  // Reject (-15) usually gates the entry; boost (+5) lifts the score.
  let taCheck = null, taAdj = 0, taLine = '';
  try {
    const { taEntryCheck } = await import('./ta.js');
    taCheck = taEntryCheck(t.address, t.mc);
    taAdj = taCheck.adjustment || 0;
    if (taCheck.decision === 'reject') taLine = `TA reject: ${taCheck.reason}`;
    else if (taCheck.decision === 'boost') taLine = `TA boost: ${taCheck.reason}`;
  } catch { /* fail-open: no TA data = no adjustment */ }
  const finalScore = Math.max(0, Math.min(100, score + boost + moverBonus + qualityBonus + taAdj - m5pen));
  const sig = {
    ...base, verdict: 'SCORED',
    score: finalScore, rawScore: r.score,
    researchMod, researchLine: r.researchLine || null,
    calloutLine: r.calloutLine || null,
    judgeMod: r.judgeMod || 0, judgeLine: r.judgeLine || null,
    breakdown: r.breakdown, dossier: r.dossier || null,
    adapted: !!r.adapted,
    eliteHit: !!r.eliteHit,
    flowTag: !!r.flowTag,
    entryMc: t.mc,
    // (v3.25 fix: these crashed paper.js when set before declaration)
    ...(moverBonus > 0 ? { moverBonus: `${t.moverSetup} +${moverBonus}` } : {}),
    ...(m5pen > 0 ? { m5Penalty: m5pen } : {}),
    ...(qualityBonus > 0 ? { qualityBonus: `+${qualityBonus} (${qualityLine})` } : {}),
    ...(taLine ? { ta: taLine } : {}),
  };

  const R = getRealBook();
  const openPositions = (R && R.positions) || [];

  const gate = (why) => {
    sig.reason = `SCORED ${finalScore} · no entry: ${why}`;
    floorEmit('trade.skip', { mint: t.address, symbol: t.symbol, name: t.name, score: finalScore, reason: why });
    return done(sig, false);
  };

  // v3.39 APE MODE per user ("fuck all the restriction bullshit") — ALL entry
  // gates disabled except: honeypot check, wallet balance (realbook), max positions.
  // v3.41 MINIMAL dead-coin gates per user ("don't buy dead shit" — BotPfp had
  // 3 holders / $3.3K MC and got bought). These are the ONLY filters back.
  const holderCount = (t.holders != null ? t.holders : (r.dossier && r.dossier.holderCount));
  if (holderCount != null && holderCount < 50) return gate(`dead coin — ${holderCount} holders (< 50)`);
  if (t.mc != null && t.mc > 0 && t.mc < 10000) return gate(`dead coin — $${Math.round(t.mc)} MC (< $10K)`);
  // if (STABLE_MINTS.has(t.address)) return gate('stablecoin excluded');
  // if (!(finalScore >= cfg.minTokenScore)) return gate(`score ${finalScore} < ${cfg.minTokenScore} bar`);
  // v3.32 TA resistance gate — DISABLED v3.39 (ape mode). Was a hard skip on
  // buying into the ceiling. Logged to registry evaluation record.
  // if (taCheck && taCheck.decision === 'reject') {
  //   try { floorEmit('ta.reject', { mint: t.address, symbol: t.symbol, reason: taCheck.reason, swingHigh: taCheck.swingHigh }); } catch {}
  //   try {
  //     const { registryAttachTa } = await import('./registry.js');
  //     registryAttachTa(t.address, taCheck);
  //   } catch { /* registry is additive */ }
  //   return gate(`TA: ${taCheck.reason}`);
  // }
  // v3.32: log TA boost/neutral decisions to the evaluation record too.
  if (taCheck && taCheck.decision !== 'skip') {
    try { floorEmit('ta.check', { mint: t.address, symbol: t.symbol, decision: taCheck.decision, reason: taCheck.reason }); } catch {}
    try {
      const { registryAttachTa } = await import('./registry.js');
      registryAttachTa(t.address, taCheck);
    } catch { /* registry is additive */ }
  }
  // Wash-trade filter: DISABLED v3.38 (was blocking too much — bot paralyzed, 0 trades)
  // Bots making tiny identical buys (~0.02 SOL) fake volume and "activity";
  // the MM then dumps to zero (X Coin pattern — unexitable).
  // let washCheck = null, washAdj = 0;
  // try {
  //   const { checkBuyDistribution } = await import('./washtrade.js');
  //   washCheck = await checkBuyDistribution(t.address);
  //   if (washCheck.isWashTrade) washAdj = -20;
  // } catch { /* fail-open: no wash data = no adjustment */ }
  // if (washCheck && washCheck.isWashTrade) {
  //   try { floorEmit('wash.reject', { mint: t.address, symbol: t.symbol, reason: washCheck.reason, stats: washCheck.stats }); } catch {}
  //   return gate(`wash trading: ${washCheck.reason} (score ${Math.max(0, finalScore + washAdj)})`);
  // }
  // v3.37: snipe-and-farm fake pattern: DISABLED v3.38 (was blocking too much)
  // dev snipes own launch (one vertical candle to ~$400K), then farms sideways
  // with a volume bot (tiny identical 0.01/0.02 buys from ~5 wallets) to trick
  // bots into aping, then rugs to zero. User has seen this exact pattern 3-4x.
  // let fakeCheck = null, fakeAdj = 0;
  // try {
  //   const { detectSnipeAndFarm } = await import('./fakepattern.js');
  //   fakeCheck = await detectSnipeAndFarm(t.address);
  //   if (fakeCheck.isFake && fakeCheck.confidence === 'high') fakeAdj = -25;
  // } catch { /* fail-open: no pattern data = no adjustment */ }
  // if (fakeCheck && fakeCheck.isFake && fakeCheck.confidence === 'high') {
  //   try { floorEmit('fakepattern.reject', { mint: t.address, symbol: t.symbol, reason: fakeCheck.reason, confidence: fakeCheck.confidence }); } catch {}
  //   return gate(`snipe-and-farm fake pattern: ${fakeCheck.reason} (score ${Math.max(0, finalScore + fakeAdj)})`);
  // }
  // if (fakeCheck && fakeCheck.isFake) {
  //   try { floorEmit('fakepattern.flag', { mint: t.address, symbol: t.symbol, reason: fakeCheck.reason, confidence: fakeCheck.confidence }); } catch {}
  // }
  if (openPositions.length >= cfg.maxPositions) return gate(`max ${cfg.maxPositions} positions open`);
  // v3.39 APE MODE — already-holding + cooldown gates DISABLED per user.
  // Re-entry into a held coin is allowed (user liked the double-entry behavior).
  // if (openPositions.some(x => x.mint === t.address)) return gate(`already holding ${t.symbol}`);
  // const cd = (R && R.cooldowns || {})[t.address];
  // if (cd && now - cd < cfg.cooldownMin * 60000)
  //   return gate(`cooldown — ${fmtDur(cfg.cooldownMin * 60000 - (now - cd))} left`);

  // v3.37: FLAT 0.05 SOL for ALL trades per user — no score tiers, no volume boost.
  // "no matter what the fuck the score is push it with 0.05"
  let solSize = 0.05;
  const spx = (opts && opts.solPrice) || 150; // v3.39: restored — v3.37 dropped it, sizeUsd went NaN
  // v3.39 APE MODE — no-price gate DISABLED per user. Honeypot check is the safety net.
  // if (!(t.price > 0)) return gate('no price');

  // v3.26: Start honeypot check EARLY (parallel) — runs during thinker/entry prep.
  const hpPromise = honeypotCheck(t.address, 6).catch(e => ({
    pass: false, reason: `honeypot check errored — uncertain, skip`
  }));

  // v3.22 FREE THINKER: per-coin adaptive TP/SL/size.
  let adaptiveReasoning = [];
  let adaptiveTp = null, adaptiveSl = null;
  try {
    const walletUsd = R ? R.cash + openPositions.reduce((a, x) => a + (x.sizeUsd || 0), 0) : 0;
    const thinkToken = { ...t, score: finalScore, buyPressure: (r.breakdown && r.breakdown.buyPressure) || null };
    const adaptive = thinkEntry(thinkToken, cfg, walletUsd);
    adaptiveReasoning = adaptive.reasoning || [];
    // v3.38: FLAT 0.05 — do NOT let thinker override size (was undoing flat sizing)
    // adaptive.solSize intentionally ignored per user: "push it with 0.05"
    adaptiveTp = adaptive.tp;
    adaptiveSl = adaptive.sl;
  } catch { /* thinker failed → use standard sizing */ }

  const entryMc = (t.mc || 0) * (1 + cfg.slippage);
  const entry = {
    mint: t.address, symbol: t.symbol, name: t.name,
    solSize, sizeUsd: solSize * spx,
    entryMc, entryPrice: t.price,
    score: finalScore,
    eliteHit: !!r.eliteHit, flowTag: !!r.flowTag,
    feeds: t.feeds || null,
    buyPressure: (r.breakdown && r.breakdown.buyPressure) || null,
    entryVol: t.vol24h || null,
    breakdown: r.breakdown,
    researchMod, researchLine: r.researchLine || null,
    adaptiveTp, adaptiveSl,
    // v3.20: conviction holds — high-score plays get more time to run.
    maxHoldMs: finalScore >= 70 ? 4 * 3600e3 : finalScore >= 50 ? 2.5 * 3600e3 : null,
    // v3.20: bundle distribution tracking.
    bundleAtEntry: r.dossier && r.dossier.bundlePct != null ? r.dossier.bundlePct : null,
  };

  // v3.26 ANTISCAM: honeypot simulation — await the parallel check started earlier.
  // No route or dust output = unexitable = skip.
  const hp = await hpPromise;
  if (!hp.pass) {
    sig.reason = `SCORED ${finalScore} · no entry: ${hp.reason}`;
    floorEmit('trade.skip', { mint: t.address, symbol: t.symbol, name: t.name, score: finalScore, reason: hp.reason });
    return done(sig, false);
  }

  // REAL-ONLY: execute on-chain. realEnter applies the real-money guardrails
  // (kill switch, position cap, wallet balance, dust floor) and fails closed.
  let pos = null;
  try {
    pos = await realEnter(entry, t, cfg);
  } catch (e) {
    console.error('[realtrade] realEnter threw:', e.message);
  }
  if (!pos) {
    sig.reason = `SCORED ${finalScore} · real entry skipped/failed (see real.skip events)`;
    return done(sig, false);
  }

  sig.taken = true;
  const thinkerNote = adaptiveReasoning.length ? ` 🧠[${adaptiveReasoning.join('; ')}]` : '';
  const adaptiveNote = (adaptiveTp != null) ? ` TP ${Math.round(adaptiveTp * 100)}%/SL ${Math.round(adaptiveSl * 100)}%` : '';
  sig.reason = `ENTER ${t.symbol} · score ${finalScore}${researchMod ? ` (${researchMod >= 0 ? '+' : ''}${researchMod} research)` : ''}${r.eliteHit ? ` (+${boost} smart flow)` : ''} · ${pos.solSize.toFixed(2)} SOL (${fmtUsd(pos.sizeUsd)}) @ ${fmtUsd(entryMc)} MC${adaptiveNote}${thinkerNote} · ${pos.route || 'jupiter'}`;
  return done(sig, true);
}

/**
 * Evaluate exits for all open real positions. This is paper.js tick() with
 * the paper ledger removed — identical exit rules, real on-chain sells.
 * Returns the closed trades.
 */
export async function tickReal(priceMap, eliteSwaps, cfg) {
  const R = getRealBook();
  if (!R) return [];
  const now = Date.now();
  const closed = [];
  let rules = null;
  try { rules = getExitRules(cfg); } catch { rules = null; }

  // v3.31: WALLET RECONCILIATION — detect manual sells before evaluating exits.
  // If the user sold from the wallet, the position is marked MANUALLY_CLOSED
  // (not "unexitable") with the current market price for P&L.
  try {
    const { reconcilePositions } = await import('./realbook.js');
    const manualClosed = await reconcilePositions(priceMap);
    if (manualClosed.length) closed.push(...manualClosed);
  } catch (e) {
    console.error('[realtrade] reconcile failed:', e.message);
  }

  for (const pos of [...(R.positions || [])]) {
    const t = priceMap[pos.mint];
    // v3.24: MAX HOLD TIME — memecoin that hasn't hit TP in 4h is a zombie.
    const holdMs = now - pos.entryTs;
    if (holdMs > 4 * 3600000) {
      const trade = await realClosePosition(pos.mint, `🧹 zombie — held ${Math.round(holdMs / 3600000)}h without TP`, cfg);
      if (trade) closed.push(trade);
      continue;
    }
    // DEAD POSITION SWEEPER: no price data for 15+ min, or price is 0.
    if (!t || !t.price || !t.mc) {
      const staleMs = now - (pos.lastPriceTs || pos.entryTs);
      if (staleMs > 15 * 60000) {
        const trade = await realClosePosition(pos.mint, `🧹 dead — no price data for ${Math.round(staleMs / 60000)}m`, cfg);
        if (trade) closed.push(trade);
        continue;
      }
      continue;
    }
    pos.lastPriceTs = now;
    // Zero MC = coin is dead — realClosePosition sells what the wallet holds
    // (likely dust/zero); if nothing to sell it drops the book entry.
    if (t.mc <= 0) {
      const trade = await realClosePosition(pos.mint, `🧹 dead — MC went to $0`, cfg);
      if (trade) closed.push(trade);
      continue;
    }
    const midMultiple = pos.entryMc > 0 ? t.mc / pos.entryMc : 1;
    if (midMultiple > (pos.peakMultiple || 1)) pos.peakMultiple = midMultiple;

    let reason = null;

    // v3.22: LIQUIDITY DEATH CHECK — liquidity < $200 or < 50% of position = dead.
    const liq = t.liquidity || 0;
    const posValue = pos.sizeUsd * midMultiple;
    if (liq < 200 || liq < posValue * 0.5) {
      reason = `💀 liquidity death — $${Math.round(liq)} liq vs $${Math.round(posValue)} position (unexitable)`;
    }

    // v3.22 FREE THINKER: discretionary exit check FIRST.
    if (!reason) try {
      const think = thinkExit(pos, t, cfg);
      if (think) {
        if (think.action === 'sell') reason = `🧠 ${think.reason}`;
        pos._thinkerHold = think.action === 'hold';
        if (think.action === 'hold') pos._thinkerReason = think.reason;
      } else {
        pos._thinkerHold = false;
      }
    } catch { /* thinker error → fall through to mechanical */ }

    // Mechanical exits (skipped when the thinker says "hold").
    if (!reason && !pos._thinkerHold && rules) {
      try {
        const pol = exitPolicy(pos, t, cfg, rules);
        if (pol) reason = pol.reason;
      } catch { /* policy error → mechanical fallback below */ }
    }
    if (!reason && !pos._thinkerHold) {
      if (midMultiple >= 1 + cfg.takeProfit) {
        reason = `take-profit +${Math.round(cfg.takeProfit * 100)}%`;
      } else if (midMultiple <= 1 - cfg.stopLoss) {
        reason = `stop-loss −${Math.round(cfg.stopLoss * 100)}%`;
      } else if (pos.peakMultiple >= 1 + cfg.trailingArmAt && midMultiple <= pos.peakMultiple * (1 - cfg.trailingStop)) {
        reason = `trailing stop −${Math.round(cfg.trailingStop * 100)}% from peak`;
      } else if (now - pos.entryTs >= (pos.maxHoldMs || cfg.maxHoldHours * 3600e3)) {
        reason = `max hold ${((pos.maxHoldMs || cfg.maxHoldHours * 3600e3) / 3600e3).toFixed(1)}h reached`;
      }
    }
    if (!reason && eliteSwaps) {
      let sellers = 0;
      const names = [];
      for (const addr of Object.keys(eliteSwaps)) {
        const sells = (eliteSwaps[addr].sells || []).filter(s => s.mint === pos.mint && s.ts >= pos.entryTs);
        if (sells.length) { sellers++; if (names.length < 3) names.push(eliteSwaps[addr].label || 'elite'); }
      }
      if (sellers >= 2) reason = `elite exit: ${sellers} elite sellers (${names.join(', ')})`;
    }

    if (!reason) continue;

    const trade = await realClosePosition(pos.mint, reason, cfg);
    if (trade) closed.push(trade);
  }
  return closed;
}
