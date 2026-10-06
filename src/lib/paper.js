// Paper trading engine — server-side edition (ported from the frontend desk).
// Fake money, real signals. The portfolio persists in ab_desk_state
// (durable when a DB is present) via an in-memory mirror + write-through.
// Nothing here touches real funds. Never promises profit.

import { pool, hasDb } from '../db/pool.js';
import { STABLE_MINTS } from './helius.js';
import { floorEmit } from './events.js';
import { exitPolicy, getExitRules } from './exits.js';
import { logTradeEntry, logTradeExit, noteCreatorLaunchCount } from './learning.js';
import { fmtUsd, fmtDur } from './fmt.js';
import { solPrice } from './dexscreener.js';

// ------------------------------------------------------------ portfolio state
let P = null; // in-memory mirror
let hydrated = false;

export function freshPortfolio(bankroll0, bankrollSol) {
  return {
    bankroll0, cash: bankroll0,
    bankrollSol: bankrollSol || null,   // SOL-denominated book (v3.8)
    equity: [{ ts: Date.now(), v: bankroll0 }],
    positions: [],
    closed: [],
    signals: [],
    cooldowns: {},
    createdAt: Date.now(),
    version: 4,   // v3.8: 5-SOL bankroll — fresh paper portfolio
  };
}

function persist() {
  if (!hasDb || !hydrated || !P) return;
  pool.query(
    `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [JSON.stringify(P)]
  ).catch(() => {});
}

export async function initPortfolio(cfg) {
  if (hasDb) {
    try {
      const { rows } = await pool.query('SELECT state FROM ab_desk_state WHERE id = 1');
      if (rows.length && rows[0].state && Array.isArray(rows[0].state.positions)) {
        // v3.8: version gate — old sizing/bankroll regimes don't carry over.
        if (rows[0].state.version === 4) {
          P = rows[0].state;
          hydrated = true;
          console.log(`[paper] portfolio restored: $${(P.cash || 0).toFixed(0)} cash, ${(P.positions || []).length} open, ${(P.closed || []).length} closed`);
          return P;
        }
        console.log(`[paper] portfolio version ${rows[0].state.version || '?'} → resetting to v4 (5-SOL bankroll)`);
      }
    } catch (e) {
      console.error('[paper] restore failed:', e.message);
    }
  }
  // Bankroll is SOL-denominated (user: 5 SOL). USD book value is set once at
  // creation from the live SOL price; positions are sized in SOL throughout.
  const bSol = cfg.bankrollSol || 0;
  let spx0 = 150;
  try { spx0 = await solPrice(); } catch { /* fallback */ }
  const startUsd = bSol > 0 ? bSol * spx0 : cfg.bankroll0;
  console.log(`[paper] fresh portfolio: ${bSol > 0 ? bSol + ' SOL' : ''} ≈ $${startUsd.toFixed(0)} @ $${spx0.toFixed(0)}/SOL`);
  P = freshPortfolio(startUsd, bSol > 0 ? bSol : null);
  hydrated = true;
  persist();
  return P;
}

export function getPortfolio() {
  return P;
}

const MAX_SIGNALS = 400;
export function logSignal(p, s) {
  p.signals = [s, ...(p.signals || [])].slice(0, MAX_SIGNALS);
}

// Process one vet result into a signal record, opening a paper position when
// the score clears the bar and the risk gates pass. Mutates portfolio.
export function processResult(p, r, cfg, opts = {}) {
  const now = Date.now();
  const t = r.t;
  const base = {
    id: `${t.address}-${Math.floor(now / 1000)}`,
    ts: now, mint: t.address,
    symbol: t.symbol, name: t.name,
    taken: false, reason: '',
  };
  const done = (sig, entered) => {
    if (!opts.silent) logSignal(p, sig);
    persist();
    return { signal: sig, entered };
  };

  if (r.verdict === 'KILLED') {
    const sig = { ...base, verdict: 'KILLED', killPass: r.killPass, killReason: r.killReason, reason: `KILLED [${r.killPass}] · ${r.killReason}` };
    return done(sig, false);
  }

  let score = r.score;
  const researchMod = r.researchMod || 0;
  score = Math.max(0, Math.min(100, score + researchMod));
  const boost = r.eliteHit ? cfg.eliteBoost : 0;
  const finalScore = Math.min(100, score + boost);
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
  };

  const gate = (why) => {
    sig.reason = `SCORED ${finalScore} · no entry: ${why}`;
    floorEmit('trade.skip', { mint: t.address, symbol: t.symbol, name: t.name, score: finalScore, reason: why });
    return done(sig, false);
  };

  if (STABLE_MINTS.has(t.address)) return gate('stablecoin excluded');
  if (!(finalScore >= cfg.minTokenScore)) return gate(`score ${finalScore} < ${cfg.minTokenScore} bar`);
  if ((p.positions || []).length >= cfg.maxPositions) return gate(`max ${cfg.maxPositions} positions open`);
  if ((p.positions || []).some(x => x.mint === t.address)) return gate(`already holding ${t.symbol}`);
  const cd = (p.cooldowns || {})[t.address];
  if (cd && now - cd < cfg.cooldownMin * 60000)
    return gate(`cooldown — ${fmtDur(cfg.cooldownMin * 60000 - (now - cd))} left`);

  // v3.8: SOL-denominated sizing. Whale-ape rule first (MC > $500k + high
  // volume → 2.5 SOL), then conviction bands by score. USD accounting stays;
  // SOL price arrives via opts (fetched once per cycle, cached).
  const spx = (opts && opts.solPrice) || 150;
  const turnover = (t.vol24h && t.mc) ? t.vol24h / t.mc : 0;
  let solSize;
  if (t.mc > (cfg.whaleMcUsd || 500000) && turnover >= (cfg.whaleTurnoverMin || 1.0)) {
    solSize = cfg.whaleSolSize || 2.5;
  } else if (t.mc < (cfg.earlyMcUsd || 100000) && finalScore >= (cfg.earlyMinScore || 80)) {
    solSize = cfg.earlySolSize || 1.0;   // early + strong score → conviction ape
  } else {
    solSize = finalScore >= 85 ? cfg.solSizeTop
      : finalScore >= 75 ? cfg.solSizeMid : cfg.solSizeBase;
  }
  solSize = solSize || 0.2;
  const sizeUsd = Math.min(p.cash, solSize * spx);
  if (!(sizeUsd > 1)) return gate(`cash too low (${fmtUsd(p.cash)})`);
  if (!(t.price > 0)) return gate('no price');

  const entryPrice = t.price * (1 + cfg.slippage);
  const entryMc = (t.mc || 0) * (1 + cfg.slippage);
  const tokens = sizeUsd / entryPrice;
  p.cash = Math.max(0, p.cash - sizeUsd);
  const pos = {
    mint: t.address, symbol: t.symbol, name: t.name,
    entryMc, entryPrice, entryTs: now,
    sizeUsd, solSize, tokens, peakMultiple: 1,
    score: finalScore, eliteHit: !!r.eliteHit, flowTag: !!r.flowTag,
    feeds: t.feeds || null,
    buyPressure: (r.breakdown && r.breakdown.buyPressure) || null,
    entryVol: t.vol24h || null,
  };
  p.positions.push(pos);
  // Trade journal: entry snapshot (durable learning).
  try {
    logTradeEntry({
      mint: pos.mint, symbol: pos.symbol, entryMc: pos.entryMc,
      score: finalScore, breakdown: r.breakdown, feeds: t.feeds || null,
      researchMod, researchLine: r.researchLine || null, eliteHit: !!r.eliteHit,
      buyPressure: pos.buyPressure, creator: t.creator || null,
    });
    if (t.creator) noteCreatorLaunchCount(t.creator, 1);
  } catch { /* journal is a nicety */ }
  sig.taken = true;
  sig.reason = `ENTER ${t.symbol} · score ${finalScore}${researchMod ? ` (${researchMod >= 0 ? '+' : ''}${researchMod} research)` : ''}${r.eliteHit ? ` (+${boost} smart flow)` : ''} · ${solSize.toFixed(2)} SOL (${fmtUsd(sizeUsd)}) @ ${fmtUsd(entryMc)} MC`;
  floorEmit('trade.enter', {
    mint: t.address, symbol: t.symbol, name: t.name,
    score: finalScore, sizeUsd, entryMc, researchMod,
  });
  return done(sig, true);
}

// ------------------------------------------------------------ exits
export function tick(p, priceMap, eliteSwaps, cfg) {
  const now = Date.now();
  const closed = [];
  const keep = [];
  let rules = null;
  try { rules = getExitRules(cfg); } catch { rules = null; }
  for (const pos of (p.positions || [])) {
    const t = priceMap[pos.mint];
    if (!t || !t.price || !t.mc) { keep.push(pos); continue; }
    const midMultiple = t.mc / pos.entryMc;
    if (midMultiple > pos.peakMultiple) pos.peakMultiple = midMultiple;

    let reason = null;
    let learned = false;
    if (rules) {
      try {
        const pol = exitPolicy(pos, t, cfg, rules);
        if (pol) { reason = pol.reason; learned = pol.learned; }
      } catch { /* policy error → mechanical fallback below */ }
    }
    if (!reason) {
      if (midMultiple >= 1 + cfg.takeProfit) {
        reason = `take-profit +${Math.round(cfg.takeProfit * 100)}%`;
      } else if (midMultiple <= 1 - cfg.stopLoss) {
        reason = `stop-loss −${Math.round(cfg.stopLoss * 100)}%`;
      } else if (pos.peakMultiple >= 1 + cfg.trailingArmAt && midMultiple <= pos.peakMultiple * (1 - cfg.trailingStop)) {
        reason = `trailing stop −${Math.round(cfg.trailingStop * 100)}% from peak`;
      } else if (now - pos.entryTs >= cfg.maxHoldHours * 3600e3) {
        reason = `max hold ${cfg.maxHoldHours}h reached`;
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

    if (!reason) { keep.push(pos); continue; }

    const exitMc = t.mc * (1 - cfg.slippage);
    const proceeds = pos.tokens * t.price * (1 - cfg.slippage);
    const pnl = proceeds - pos.sizeUsd;
    p.cash += proceeds;
    p.cooldowns = { ...(p.cooldowns || {}), [pos.mint]: now };
    const trade = {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      entryMc: pos.entryMc, exitMc,
      multiple: pos.sizeUsd > 0 ? proceeds / pos.sizeUsd : 1,
      pnlUsd: pnl,
      holdMs: now - pos.entryTs,
      exitReason: reason,
      entryTs: pos.entryTs, exitTs: now,
      score: pos.score, eliteHit: pos.eliteHit,
      learned,
    };
    p.closed = [trade, ...(p.closed || [])];
    closed.push(trade);
    try { logTradeExit(trade); } catch { /* journal is a nicety */ }
    floorEmit('risk.exit', {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      exitReason: reason, pnlUsd: pnl, multiple: pos.sizeUsd > 0 ? proceeds / pos.sizeUsd : 1,
      learned: !!learned,
    });
  }
  p.positions = keep;
  if (closed.length) snapshotEquity(p, priceMap);
  persist();
  return closed;
}

// ------------------------------------------------------------ equity + stats
export function equityValue(p, priceMap) {
  let v = p.cash || 0;
  for (const pos of (p.positions || [])) {
    const t = priceMap[pos.mint];
    if (t && t.price) v += pos.tokens * t.price;
  }
  return v;
}

export function snapshotEquity(p, priceMap) {
  const v = equityValue(p, priceMap);
  const eq = p.equity || [];
  if (!eq.length || eq[eq.length - 1].v !== v || Date.now() - eq[eq.length - 1].ts > 60000) {
    p.equity = [...eq, { ts: Date.now(), v }].slice(-2000);
  }
  persist();
}

export function statsFor(p, priceMap) {
  const closed = p.closed || [];
  const wins = closed.filter(c => c.pnlUsd > 0);
  const losses = closed.filter(c => c.pnlUsd <= 0);
  const realized = closed.reduce((s, c) => s + (c.pnlUsd || 0), 0);
  let unrealized = 0;
  for (const pos of (p.positions || [])) {
    const t = priceMap[pos.mint];
    const cur = t && t.price ? pos.tokens * t.price : pos.sizeUsd;
    unrealized += cur - pos.sizeUsd;
  }
  const total = realized + unrealized;
  const avgMult = closed.length ? closed.reduce((s, c) => s + (c.multiple || 1), 0) / closed.length : null;
  return {
    cash: p.cash || 0,
    equity: equityValue(p, priceMap),
    totalPnl: total,
    totalPnlPct: p.bankroll0 ? total / p.bankroll0 : null,
    winRate: closed.length ? wins.length / closed.length : null,
    wins: wins.length, losses: losses.length,
    avgMultiple: avgMult,
    openCount: (p.positions || []).length,
    totalTrades: closed.length,
  };
}
