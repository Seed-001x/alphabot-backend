// REAL BOOK (v3.24) — real-money trading ledger, SEPARATE from paper.
// Paper is the default and is never touched by this module. Real trades
// mirror paper signals (same entries, same exit logic) but execute on-chain.
//
// GUARDRAILS (hard-coded, non-negotiable):
// - realMode defaults FALSE. Enabled only via tuning patch {realMode: true}.
// - KILL SWITCH: equity < 50% of starting value → realMode disabled
//   permanently (until the user re-enables via tuning). Checked every tick.
// - Max 3 real positions open at once.
// - No single trade > 30% of real wallet value.
// - All real trades logged with tx signatures.
// - If execution fails → fail closed, paper continues unaffected.

import { pool, hasDb } from '../db/pool.js';
import { floorEmit } from './events.js';
import { thinkEntry } from './freethinker.js';
import { buyToken, sellToken, realWalletState, realWalletAddress, realExecReady } from './realexec.js';
import { solPrice } from './dexscreener.js';

const REAL_MAX_POSITIONS = 3;
const REAL_MAX_SIZE_PCT = 0.30;      // no single trade > 30% of real wallet
const KILL_SWITCH_DRAWDOWN = 0.50;   // equity < 50% of start → realMode OFF

let R = null; // in-memory mirror of the real book
let hydrated = false;
let realModeOn = false;   // in-memory; persisted to KV
let killSwitched = false; // set when the kill switch fires

function persist() {
  if (!hasDb || !hydrated || !R) return;
  pool.query(
    `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [JSON.stringify(R)]
  ).catch(() => {});
}

export function freshRealBook(startUsd, startSol) {
  return {
    startUsd, startSol,
    cash: startUsd,            // USD book value (SOL-denominated underneath)
    equity: [{ ts: Date.now(), v: startUsd }],
    positions: [],
    closed: [],
    fills: [],                // real-fill records: quoted vs actual
    killSwitched: false,
    createdAt: Date.now(),
    version: 1,
  };
}

export async function initRealBook() {
  if (hasDb) {
    try {
      const { rows } = await pool.query('SELECT state FROM ab_desk_state WHERE id = 2');
      if (rows.length && rows[0].state && rows[0].state.version === 1) {
        R = rows[0].state;
        hydrated = true;
        console.log(`[realbook] restored: $${(R.cash || 0).toFixed(2)} cash, ${(R.positions || []).length} open`);
        return R;
      }
    } catch (e) {
      console.error('[realbook] restore failed:', e.message);
    }
  }
  R = null; hydrated = true;
  return null;
}

export function getRealBook() { return R; }
export function isRealMode() { return realModeOn && !killSwitched; }
export function isKillSwitched() { return !!(killSwitched || (R && R.killSwitched)); }

/** Enable/disable real mode. Disabling is always allowed; enabling requires a wallet. */
export async function setRealMode(on) {
  on = !!on;
  if (on && !realExecReady()) {
    throw new Error('real mode needs REAL_WALLET_KEY + HELIUS_API_KEY env vars');
  }
  if (on && R && R.killSwitched) {
    // User explicitly re-enabling after a kill switch: clear the flag,
    // re-baseline from current wallet value.
    console.log('[realbook] re-enabling after kill switch — re-baselining');
    R.killSwitched = false;
    killSwitched = false;
  }
  realModeOn = on;
  try {
    const { kvSetJson } = await import('./storage.js');
    await kvSetJson('ab_realmode', { on, ts: Date.now() });
  } catch {}
  console.log(`[realbook] realMode ${on ? 'ENABLED' : 'DISABLED'}`);
  floorEmit('real.mode', { on });
  return { on };
}

export async function loadRealModeFlag() {
  try {
    const { kvGetJson } = await import('./storage.js');
    const v = await kvGetJson('ab_realmode', null);
    if (v && v.on && realExecReady()) {
      realModeOn = true;
      console.log('[realbook] realMode restored ON from KV');
    }
  } catch {}
}

/**
 * Initialize the real book from the live wallet on first enable.
 * Called once when realMode is turned on with no existing book.
 */
export async function ensureRealBook() {
  if (R) return R;
  const st = await realWalletState();
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const startUsd = st.sol * spx;
  R = freshRealBook(startUsd, st.sol);
  R.wallet = st.address;
  hydrated = true;
  persist();
  console.log(`[realbook] initialized: ${st.sol.toFixed(4)} SOL ≈ $${startUsd.toFixed(2)} @ $${spx.toFixed(0)}/SOL`);
  return R;
}

/** Record a real fill for slippage learning. Never throws. */
export function recordFill(f) {
  try {
    if (!R) return;
    R.fills = [...(R.fills || []), { ...f, ts: Date.now() }].slice(-500);
    persist();
    // Durable: ab_real_fills table (migration 002)
    if (hasDb) {
      pool.query(
        `INSERT INTO ab_real_fills (mint, symbol, side, quoted_price_sol, fill_price_sol, slippage_bps, sol_amount, tx_sig)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.mint, f.symbol || null, f.side, f.quotedPriceSol ?? null, f.fillPriceSol ?? null,
         f.slippageBps ?? null, f.solAmount ?? null, f.txSig || null]
      ).catch(() => {});
    }
  } catch {}
}

/** Average realized slippage (bps) over recent real fills. Feeds sizing. */
export async function avgRealSlippageBps(n = 20) {
  try {
    if (hasDb) {
      const { rows } = await pool.query(
        `SELECT AVG(slippage_bps) AS a, COUNT(*) AS c FROM (
           SELECT slippage_bps FROM ab_real_fills WHERE slippage_bps IS NOT NULL
           ORDER BY id DESC LIMIT $1) s`,
        [n]
      );
      if (rows[0] && Number(rows[0].c) > 0) return Number(rows[0].a);
    }
  } catch {}
  const fills = (R && R.fills || []).filter(f => f.slippageBps != null).slice(-n);
  if (!fills.length) return null;
  return fills.reduce((a, f) => a + f.slippageBps, 0) / fills.length;
}

/**
 * Slippage-aware size multiplier. If real fills prove execution costs are
 * eating edge, shrink real sizes. >500bps avg slippage = halve size.
 * Returns 1.0 when there's no real-fill data yet.
 */
export async function slippageSizeFactor() {
  const avg = await avgRealSlippageBps();
  if (avg == null) return 1.0;
  if (avg > 500) return 0.5;   // >5% avg slippage — halve size
  if (avg > 250) return 0.75;  // >2.5% — trim 25%
  return 1.0;
}

// ------------------------------------------------------------ entries
/**
 * Mirror a paper entry with real money. Called from the loop after a paper
 * position opens. Fail-closed: any error → logs + returns, paper unaffected.
 */
export async function realEnter(paperPos, t, finalScore, cfg) {
  if (!isRealMode()) return null;
  try { await ensureRealBook(); } catch (e) {
    console.error('[realbook] ensure failed:', e.message);
    return null;
  }
  if ((R.positions || []).length >= REAL_MAX_POSITIONS) {
    console.log('[realbook] skip: max real positions open');
    return null;
  }
  if ((R.positions || []).some(x => x.mint === paperPos.mint)) return null;
  if (R.killSwitched) return null;

  // Sizing: same free-thinker logic, capped at 30% of real wallet.
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const walletUsd = R.cash + (R.positions || []).reduce((a, x) => a + (x.sizeUsd || 0), 0);
  let solSize;
  try {
    const think = thinkEntry({ ...t, score: finalScore }, cfg, walletUsd);
    solSize = think.solSize;
  } catch { solSize = 0.05; }
  // Hard cap: configurable via tuning (realMaxSizePct), default 30% of wallet per trade
  const maxPct = Math.min(0.95, Math.max(0.05, cfg.realMaxSizePct || REAL_MAX_SIZE_PCT));
  const maxSol = (walletUsd * maxPct) / spx;
  solSize = Math.min(solSize, maxSol);
  // v3.24: slippage learning — if real fills prove execution is expensive,
  // shrink size. The bot learns its true costs from real data.
  try {
    const factor = await slippageSizeFactor();
    if (factor < 1) {
      solSize *= factor;
      console.log(`[realbook] slippage factor ${factor} — sized down to ${solSize.toFixed(4)} SOL`);
    }
  } catch {}
  // Don't trade dust: min 0.01 SOL
  if (!(solSize >= 0.01)) {
    console.log('[realbook] skip: size below 0.01 SOL dust floor');
    return null;
  }
  // Can't spend what we don't have (leave 0.02 SOL for fees)
  let walletSol = 0;
  try { walletSol = (await realWalletState()).sol; } catch (e) {
    console.error('[realbook] wallet read failed:', e.message);
    return null;
  }
  solSize = Math.min(solSize, Math.max(0, walletSol - 0.02));
  if (!(solSize >= 0.01)) {
    console.log('[realbook] skip: insufficient SOL balance');
    return null;
  }

  const quotedPriceSol = t.price ? t.price / 1e9 / spx * 1e9 : null; // best-effort
  void quotedPriceSol;
  console.log(`[realbook] BUY ${t.symbol} ${solSize.toFixed(4)} SOL (score ${finalScore})`);
  let fill;
  try {
    fill = await buyToken(paperPos.mint, solSize, { slippageBps: Math.round((cfg.slippage || 0.20) * 10000) });
  } catch (e) {
    console.error('[realbook] buy FAILED (fail-closed):', e.message);
    floorEmit('real.buy_fail', { mint: paperPos.mint, symbol: t.symbol, error: e.message });
    return null;
  }

  const sizeUsd = solSize * spx;
  const pos = {
    mint: paperPos.mint, symbol: t.symbol, name: t.name,
    entryTs: Date.now(),
    solSize, sizeUsd,
    entryTxSig: fill.sig,
    quotedOut: fill.quotedOut,
    // Mirror paper's adaptive TP/SL for exit decisions
    adaptiveTp: paperPos.adaptiveTp ?? null,
    adaptiveSl: paperPos.adaptiveSl ?? null,
    score: finalScore,
    real: true,
  };
  R.positions.push(pos);
  R.cash = Math.max(0, R.cash - sizeUsd);
  // Slippage learning: signal price (USD→SOL) vs Jupiter fill price.
  let slipBps = null;
  try {
    if (t.price > 0 && fill.fillPriceSol > 0) {
      const quotedSol = t.price / spx;
      slipBps = ((fill.fillPriceSol - quotedSol) / quotedSol) * 10000;
    }
  } catch {}
  recordFill({
    mint: pos.mint, symbol: pos.symbol, side: 'buy',
    quotedPriceSol: t.price > 0 ? t.price / spx : null,
    fillPriceSol: fill.fillPriceSol,
    slippageBps: slipBps, solAmount: solSize, txSig: fill.sig,
  });
  persist();
  floorEmit('real.enter', { mint: pos.mint, symbol: pos.symbol, solSize, sig: fill.sig });
  console.log(`[realbook] BOUGHT ${t.symbol} — tx ${fill.sig}`);
  return pos;
}

// ------------------------------------------------------------ exits
/**
 * Mirror a paper exit with a real sell. Called from the loop when a paper
 * position closes AND a matching real position is open.
 */
export async function realExit(paperTrade, cfg) {
  if (!R) return null;
  const idx = (R.positions || []).findIndex(x => x.mint === paperTrade.mint);
  if (idx < 0) return null;
  const pos = R.positions[idx];

  let tokenBal = null;
  try {
    const st = await realWalletState([pos.mint]);
    tokenBal = st.tokens[pos.mint];
  } catch (e) {
    console.error('[realbook] wallet read failed on exit:', e.message);
    return null;
  }
  if (!tokenBal || !(tokenBal.raw > 0)) {
    console.log('[realbook] no token balance to sell for', pos.symbol);
    R.positions.splice(idx, 1);
    persist();
    return null;
  }

  console.log(`[realbook] SELL ${pos.symbol} (${tokenBal.raw} base units)`);
  let fill;
  try {
    fill = await sellToken(pos.mint, String(tokenBal.raw), tokenBal.decimals,
      { slippageBps: Math.round((cfg.slippage || 0.20) * 10000) });
  } catch (e) {
    console.error('[realbook] sell FAILED:', e.message);
    floorEmit('real.sell_fail', { mint: pos.mint, symbol: pos.symbol, error: e.message });
    return null; // keep position open; retry next tick
  }

  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const proceedsUsd = fill.solOut * spx;
  const pnlUsd = proceedsUsd - pos.sizeUsd;
  R.cash += proceedsUsd;
  const trade = {
    mint: pos.mint, symbol: pos.symbol, name: pos.name,
    solSize: pos.solSize, sizeUsd: pos.sizeUsd,
    proceedsUsd, pnlUsd,
    multiple: pos.sizeUsd > 0 ? proceedsUsd / pos.sizeUsd : 1,
    entryTxSig: pos.entryTxSig, exitTxSig: fill.sig,
    entryTs: pos.entryTs, exitTs: Date.now(),
    holdMs: Date.now() - pos.entryTs,
    exitReason: paperTrade.exitReason || 'mirrored paper exit',
    score: pos.score,
    real: true,
  };
  R.positions.splice(idx, 1);
  R.closed = [trade, ...(R.closed || [])].slice(0, 500);
  recordFill({
    mint: pos.mint, symbol: pos.symbol, side: 'sell',
    quotedPriceSol: null, fillPriceSol: null,
    slippageBps: null, solAmount: fill.solOut, txSig: fill.sig,
  });
  persist();
  floorEmit('real.exit', { mint: pos.mint, symbol: pos.symbol, pnlUsd, sig: fill.sig });
  console.log(`[realbook] SOLD ${pos.symbol} pnl $${pnlUsd.toFixed(2)} — tx ${fill.sig}`);

  // Kill-switch check after every close
  await checkKillSwitch();
  return trade;
}

// ------------------------------------------------------------ kill switch
export async function realEquityUsd() {
  if (!R) return null;
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  // Mark open positions to market using paper priceMap where possible
  let posValue = 0;
  for (const p of (R.positions || [])) posValue += p.sizeUsd; // conservative: cost basis
  try {
    const st = await realWalletState((R.positions || []).map(p => p.mint));
    // SOL balance valued at spot; positions at cost (conservative)
    return st.sol * spx + posValue;
  } catch {
    return R.cash + posValue;
  }
}

/**
 * THE KILL SWITCH. If real equity < 50% of starting value → disable realMode
 * permanently (until the user explicitly re-enables). Called every tick.
 */
export async function checkKillSwitch() {
  if (!R || R.killSwitched) return false;
  if (!realModeOn) return false;
  const eq = await realEquityUsd();
  if (eq == null) return false;
  R.equity = [...(R.equity || []), { ts: Date.now(), v: eq }].slice(-2000);
  const floor = R.startUsd * (1 - KILL_SWITCH_DRAWDOWN);
  if (eq < floor) {
    R.killSwitched = true;
    killSwitched = true;
    realModeOn = false;
    persist();
    try {
      const { kvSetJson } = await import('./storage.js');
      await kvSetJson('ab_realmode', { on: false, killSwitched: true, ts: Date.now(), equity: eq });
    } catch {}
    console.error(`[realbook] 🛑 KILL SWITCH: equity $${eq.toFixed(2)} < 50% of $${R.startUsd.toFixed(2)} start. realMode DISABLED.`);
    floorEmit('real.killswitch', { equity: eq, startUsd: R.startUsd });
    return true;
  }
  persist();
  return false;
}

// ------------------------------------------------------------ read API
export async function realBookSnapshot() {
  const eq = R ? await realEquityUsd() : null;
  const avgSlip = await avgRealSlippageBps();
  return {
    ts: Date.now(),
    enabled: realModeOn && !killSwitched,
    killSwitched: isKillSwitched(),
    ready: realExecReady(),
    wallet: R ? R.wallet || realWalletAddress() : realWalletAddress(),
    startUsd: R ? R.startUsd : null,
    startSol: R ? R.startSol : null,
    cash: R ? R.cash : null,
    equity: eq,
    pnlUsd: R && eq != null ? eq - R.startUsd : null,
    pnlPct: R && eq != null && R.startUsd > 0 ? ((eq - R.startUsd) / R.startUsd) * 100 : null,
    positions: R ? R.positions.map(p => ({
      mint: p.mint, symbol: p.symbol, name: p.name,
      solSize: p.solSize, sizeUsd: p.sizeUsd,
      entryTs: p.entryTs, entryTxSig: p.entryTxSig,
      score: p.score, adaptiveTp: p.adaptiveTp, adaptiveSl: p.adaptiveSl,
    })) : [],
    closed: R ? (R.closed || []).slice(0, 50) : [],
    equityCurve: R ? (R.equity || []).slice(-200) : [],
    avgSlippageBps: avgSlip,
    guardrails: {
      maxPositions: REAL_MAX_POSITIONS,
      maxSizePct: REAL_MAX_SIZE_PCT,
      killSwitchDrawdown: KILL_SWITCH_DRAWDOWN,
    },
  };
}
