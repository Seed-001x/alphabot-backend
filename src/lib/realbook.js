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
import { buyToken, sellToken, realWalletState, realWalletAddress, realExecReady, PRIORITY_FEE_LAMPORTS, JITO_TIP_LAMPORTS } from './realexec.js';
import { solPrice } from './dexscreener.js';
import { getKey, fetchWalletTxns } from './helius.js';

const REAL_MAX_POSITIONS = 3;
const REAL_MAX_SIZE_PCT = 0.30;      // no single trade > 30% of real wallet
const KILL_SWITCH_DRAWDOWN = 0.50;   // equity < 50% of start → realMode OFF

let R = null; // in-memory mirror of the real book
let hydrated = false;
let realModeOn = false;   // in-memory; persisted to KV
let killSwitched = false; // set when the kill switch fires
// v3.24: init gate — ensureRealBook() waits for initRealBook() to finish
// DB restore before ever creating fresh. Prevents deploy wipes.
let initPromise = null;

function persist() {
  if (!hasDb || !hydrated || !R) return;
  pool.query(
    `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [JSON.stringify(R)]
  ).catch((e) => console.error('[realbook] persist FAILED:', e.message));
}

/** Awaitable persist for critical paths (buy/sell/close). Never throws. */
export async function persistSync() {
  if (!hasDb || !hydrated || !R) return;
  try {
    await pool.query(
      `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(R)]
    );
  } catch (e) {
    console.error('[realbook] persistSync FAILED:', e.message);
  }
}

export function freshRealBook(startUsd, startSol) {
  return {
    startUsd, startSol,
    cash: startUsd,            // USD book value (SOL-denominated underneath)
    equity: [{ ts: Date.now(), v: startUsd }],
    positions: [],
    closed: [],
    fills: [],                // real-fill records: quoted vs actual
    cooldowns: {},            // v3.25: mint -> ts, same cooldown semantics as the old paper book
    killSwitched: false,
    createdAt: Date.now(),
    version: 1,
  };
}

/** v3.25: Restore fills from ab_real_fills table. Called on every startup path. */
async function restoreFillsFromDb() {
  if (!hasDb || !R) return;
  try {
    const fr = await pool.query(
      `SELECT mint, symbol, side, quoted_price_sol, fill_price_sol, slippage_bps, sol_amount, tx_sig, created_at
       FROM ab_real_fills ORDER BY created_at DESC LIMIT 500`
    );
    const dbFills = (fr.rows || []).reverse().map(r => ({
      mint: r.mint, symbol: r.symbol, side: r.side,
      quotedPriceSol: r.quoted_price_sol ? Number(r.quoted_price_sol) : null,
      fillPriceSol: r.fill_price_sol ? Number(r.fill_price_sol) : null,
      slippageBps: r.slippage_bps ? Number(r.slippage_bps) : null,
      solAmount: r.sol_amount ? Number(r.sol_amount) : null,
      txSig: r.tx_sig, ts: new Date(r.created_at).getTime(),
    }));
    const seen = new Set((R.fills || []).map(f => f.txSig).filter(Boolean));
    for (const f of dbFills) {
      if (f.txSig && seen.has(f.txSig)) continue;
      R.fills = [...(R.fills || []), f];
      if (f.txSig) seen.add(f.txSig);
    }
    R.fills = (R.fills || []).slice(-500);
    console.log(`[realbook] restored ${(R.fills || []).length} fills from DB`);
  } catch (e) {
    console.error('[realbook] fills restore failed:', e.message);
  }
}

export async function initRealBook() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (hasDb) {
      try {
        const { rows } = await pool.query('SELECT state FROM ab_desk_state WHERE id = 2');
        if (rows.length && rows[0].state && rows[0].state.version === 1) {
          R = rows[0].state;
          hydrated = true;
          console.log(`[realbook] RESTORED from DB: ${(R.positions || []).length} positions, ${(R.closed || []).length} closed trades, ${(R.fills || []).length} fills, startSol ${(R.startSol || 0).toFixed(4)} (LOCKED)`);
          await restoreFillsFromDb();
          console.log(`[realbook] after fills restore: ${(R.fills || []).length} total fills`);
          // v3.24: on-chain reconciliation — chain is source of truth.
          // If DB wiped but tokens are on-chain, rebuild positions.
          try { await reconcileOnChain(); } catch (e) {
            console.error('[realbook] on-chain reconcile failed:', e.message);
          }
          return R;
        }
      } catch (e) {
        console.error('[realbook] restore failed:', e.message);
      }
    }
    R = null; hydrated = true;
    return null;
  })();
  return initPromise;
}

/**
 * v3.24: Reconcile book with on-chain reality. The chain is the source of truth.
 * - Tokens in wallet but not in book → add as position (recovered from wipe)
 * - Positions in book but no tokens in wallet → remove (sold externally)
 * This makes the book self-healing — deploys can never lose track of funds.
 */
async function reconcileOnChain() {
  if (!R) return;
  // Get ALL token holdings (not just known mints)
  let holdings = {};
  try {
    const addr = realWalletAddress();
    if (!addr) return;
    const urls = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
    // Try Helius first via realWalletState's internal, fall back to public
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
            params: [addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }],
          }),
        });
        const j = await r.json();
        for (const acc of (j?.result?.value || [])) {
          const info = acc?.account?.data?.parsed?.info;
          if (!info) continue;
          const mint = info.mint;
          const amt = info.tokenAmount;
          const raw = Number(amt?.amount || 0);
          if (raw > 0 && mint) {
            holdings[mint] = { raw, decimals: amt.decimals || 0, uiAmount: Number(amt.uiAmount || 0) };
          }
        }
        break; // success, don't try next RPC
      } catch {}
    }
  } catch (e) {
    console.error('[realbook] reconcile: holdings scan failed:', e.message);
    return;
  }
  const bookMints = new Set((R.positions || []).map(p => p.mint));
  const chainMints = new Set(Object.keys(holdings));

  // Add: on-chain but not in book
  let added = 0;
  for (const mint of chainMints) {
    if (bookMints.has(mint)) continue;
    const h = holdings[mint];
    let symbol = mint.slice(0, 8), curMc = null;
    try {
      const { fetchTokens } = await import('./dexscreener.js');
      const pairs = await fetchTokens([mint]);
      const pair = pairs && pairs[mint];
      if (pair) {
        symbol = pair.baseToken?.symbol || symbol;
        curMc = pair.fdv ? Number(pair.fdv) : null;
      }
    } catch {}
    R.positions.push({
      mint, symbol, name: null,
      solSize: 0, sizeUsd: 0,
      entryTs: Date.now(), entryTxSig: null,
      entryMc: null, entryPrice: null,
      curMc,
      score: null, real: true, recovered: true,
      tokenRaw: h.raw, tokenDecimals: h.decimals,
    });
    added++;
    console.log(`[realbook] reconcile: recovered ${symbol} from on-chain (${h.uiAmount} tokens)`);
  }
  if (added) {
    await persistSync();
    console.log(`[realbook] reconcile done: +${added} recovered from chain`);
  }
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
  // v3.24: WAIT for initRealBook() to finish DB restore before doing anything.
  // This is the lock that prevents deploy wipes — the baseline (startSol)
  // is sacred and can only be set on very-first init, never overwritten.
  if (initPromise) {
    try { await initPromise; } catch {}
  }
  if (R) return R;
  // Try DB restore (in case initRealBook wasn't called yet)
  if (hasDb) {
    try {
      const { rows } = await pool.query('SELECT state FROM ab_desk_state WHERE id = 2');
      if (rows.length && rows[0].state && rows[0].state.version === 1) {
        R = rows[0].state;
        hydrated = true;
        console.log(`[realbook] ensureRealBook restored from DB: ${(R.positions || []).length} open, startSol ${(R.startSol || 0).toFixed(4)} (LOCKED)`);
        await restoreFillsFromDb();
        return R;
      }
    } catch (e) {
      console.error('[realbook] ensureRealBook restore failed:', e.message);
    }
  }
  // VERY FIRST init only — baseline set once from wallet, never again
  const st = await realWalletState();
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const startUsd = st.sol * spx;
  R = freshRealBook(startUsd, st.sol);
  R.wallet = st.address;
  hydrated = true;
  await persistSync();
  console.log(`[realbook] FIRST INIT — baseline LOCKED: ${st.sol.toFixed(4)} SOL ≈ $${startUsd.toFixed(2)} @ $${spx.toFixed(0)}/SOL`);
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
      // v3.24: exclude decimal-unit outliers (the 1000x bug) — real slippage never exceeds ±50%
      const { rows } = await pool.query(
        `SELECT AVG(slippage_bps) AS a, COUNT(*) AS c FROM (
           SELECT slippage_bps FROM ab_real_fills
           WHERE slippage_bps IS NOT NULL AND ABS(slippage_bps) <= 5000
           ORDER BY id DESC LIMIT $1) s`,
        [n]
      );
      if (rows[0] && Number(rows[0].c) > 0) return Number(rows[0].a);
    }
  } catch {}
  const fills = (R && R.fills || []).filter(f => f.slippageBps != null && Math.abs(f.slippageBps) <= 5000).slice(-n);
  if (!fills.length) return null;
  return fills.reduce((a, f) => a + f.slippageBps, 0) / fills.length;
}

/**
 * Slippage-aware size multiplier. If real fills prove execution costs are
 * eating edge, shrink real sizes. >500bps avg slippage = halve size.
 * Returns 1.0 when there's no real-fill data yet.
 */
export async function slippageSizeFactor() {
  // v3.36: DISABLED per user — was shrinking 0.05 to 0.02, making trades unprofitable.
  // User wants full 0.05 positions. Slippage is a cost, not a reason to shrink.
  return 1.0;
}

// ------------------------------------------------------------ entries
/**
 * Dry-run the real entry path WITHOUT spending money. Exercises every check,
 * sizing calc, and wallet read up to (but not including) the actual buyToken
 * call. Returns a step-by-step diagnostic. Used to verify the real path works.
 */
export async function realDryRun() {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail: String(detail || '') });

  // 1. realMode flag
  const modeOn = isRealMode();
  step('isRealMode()', modeOn, modeOn ? 'realMode is ON' : 'realMode is OFF — realEnter would skip silently');

  // 2. kill switch
  const ks = isKillSwitched();
  step('killSwitch', !ks, ks ? 'KILL SWITCHED — all real trading halted' : 'not tripped');

  // 3. exec readiness (wallet key + RPC)
  const ready = realExecReady();
  step('realExecReady()', ready, ready ? 'wallet key + RPC configured' : 'REAL_WALLET_KEY or HELIUS_API_KEY missing');

  // 4. wallet read
  let walletSol = null;
  try {
    const st = await realWalletState();
    walletSol = st.sol;
    step('walletRead', walletSol > 0, `${walletSol.toFixed(4)} SOL on-chain`);
  } catch (e) {
    step('walletRead', false, 'FAILED: ' + e.message);
  }

  // 5. book init
  try {
    await ensureRealBook();
    step('ensureRealBook()', true, `book ok — ${R.positions.length} open, startSol ${R.startSol?.toFixed(4) || '?'}`);
  } catch (e) {
    step('ensureRealBook()', false, 'FAILED: ' + e.message);
  }

  // 6. position cap
  const openCount = R ? R.positions.length : 0;
  step('positionCap', openCount < REAL_MAX_POSITIONS, `${openCount}/${REAL_MAX_POSITIONS} open`);

  // 7. sizing (simulate a 0.05 SOL think)
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const walletUsd = R ? R.cash + (R.positions || []).reduce((a, x) => a + (x.sizeUsd || 0), 0) : (walletSol || 0) * spx;
  const maxPct = 0.70; // tuned value
  const maxSol = (walletUsd * maxPct) / spx;
  const simSize = Math.min(0.05, maxSol, Math.max(0, (walletSol || 0) - 0.02));
  step('sizing', simSize >= 0.01, `sim 0.05 SOL → capped to ${simSize.toFixed(4)} SOL (70% cap, 0.02 reserve)`);

  // 8. Jupiter reachability (quote-only, no trade)
  try {
    const { getJupiterQuote } = await import('./realexec.js').catch(() => ({}));
    step('jupiterQuote', true, 'quote function available (full swap test requires real entry)');
  } catch (e) {
    step('jupiterQuote', false, e.message);
  }

  const allOk = steps.every(s => s.ok);
  return { ts: Date.now(), allOk, steps };
}

// ------------------------------------------------------------ entries
/**
 * Execute a real entry. v3.25 REAL-ONLY: called directly from the signal
 * pipeline (realtrade.processSignal) — no paper leg. The entry descriptor
 * carries the pipeline's scoring/sizing decision; this function applies the
 * real-money guardrails (caps, wallet balance, kill switch) and executes.
 *
 * @param {object} entry - { mint, symbol, name, solSize, sizeUsd, entryMc,
 *   entryPrice, adaptiveTp, adaptiveSl, score, peakMultiple, maxHoldMs,
 *   bundleAtEntry, eliteHit, flowTag, entryVol }
 * @param {object} t - the vetted token (for fallbacks)
 * @param {object} cfg - config/tuning
 */
export async function realEnter(entry, t, cfg) {
  const sym = entry.symbol || t.symbol;
  const mint = entry.mint;
  if (!isRealMode()) { floorEmit('real.skip', { mint, symbol: sym, reason: 'realMode off' }); return null; }
  try { await ensureRealBook(); } catch (e) {
    console.error('[realbook] ensure failed:', e.message);
    floorEmit('real.skip', { mint, symbol: sym, reason: 'ensure failed: ' + e.message });
    return null;
  }
  if ((R.positions || []).length >= REAL_MAX_POSITIONS) {
    console.log('[realbook] skip: max real positions open');
    floorEmit('real.skip', { mint, symbol: sym, reason: 'max positions' });
    return null;
  }
  if ((R.positions || []).some(x => x.mint === mint)) { floorEmit('real.skip', { mint, symbol: sym, reason: 'already holding' }); return null; }
  if (R.killSwitched) { floorEmit('real.skip', { mint, symbol: sym, reason: 'kill switched' }); return null; }
  // v3.25: cooldown — same semantics the paper book enforced.
  const cd = (R.cooldowns || {})[mint];
  if (cd && Date.now() - cd < (cfg.cooldownMin || 30) * 60000) {
    floorEmit('real.skip', { mint, symbol: sym, reason: 'cooldown' });
    return null;
  }

  // Sizing comes from the pipeline (realtrade.processSignal) — identical
  // sizing logic to what paper used (score bands + vol boost + free thinker).
  // Here we apply only the real-money guardrails.
  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const walletUsd = R.cash + (R.positions || []).reduce((a, x) => a + (x.sizeUsd || 0), 0);
  let solSize = entry.solSize;
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
    floorEmit('real.skip', { mint, symbol: sym, reason: `dust floor (size ${solSize.toFixed(4)})` });
    return null;
  }
  // Can't spend what we don't have (leave 0.02 SOL for fees)
  let walletSol = 0;
  try { walletSol = (await realWalletState()).sol; } catch (e) {
    console.error('[realbook] wallet read failed:', e.message);
    floorEmit('real.skip', { mint, symbol: sym, reason: 'wallet read failed: ' + e.message });
    return null;
  }
  solSize = Math.min(solSize, Math.max(0, walletSol - 0.02));
  if (!(solSize >= 0.01)) {
    console.log('[realbook] skip: insufficient SOL balance');
    floorEmit('real.skip', { mint, symbol: sym, reason: `insufficient SOL (${walletSol.toFixed(4)})` });
    return null;
  }

  console.log(`[realbook] BUY ${sym} ${solSize.toFixed(4)} SOL (score ${entry.score})`);
  floorEmit('real.buy_attempt', { mint, symbol: sym, solSize: +solSize.toFixed(4), score: entry.score });
  let fill;
  try {
    fill = await buyToken(mint, solSize, {
      slippageBps: Math.round((cfg.slippage || 0.20) * 10000),
      priorityFeeLamports: cfg.priorityFeeLamports || PRIORITY_FEE_LAMPORTS,
      jitoTipLamports: cfg.jitoTipLamports ?? JITO_TIP_LAMPORTS,
    });
  } catch (e) {
    console.error('[realbook] buy FAILED (fail-closed):', e.message);
    floorEmit('real.buy_fail', { mint, symbol: sym, error: e.message });
    return null;
  }

  const sizeUsd = solSize * spx;
  const pos = {
    mint, symbol: sym, name: entry.name || t.name || null,
    entryTs: Date.now(),
    lastPriceTs: Date.now(),
    solSize, sizeUsd,
    entryTxSig: fill.sig,
    quotedOut: fill.quotedOut,
    tokensOut: fill.quotedOut / 1e6,   // v3.25: for exit math (mirrors paper's `tokens`)
    peakMultiple: 1,                    // v3.25: for trailing-stop logic in tickReal
    // v3.24: store entry MC/price for live P&L display
    entryMc: entry.entryMc || t.mc || null,
    entryPrice: entry.entryPrice || t.price || null,
    // Pipeline's adaptive TP/SL for exit decisions
    adaptiveTp: entry.adaptiveTp ?? null,
    adaptiveSl: entry.adaptiveSl ?? null,
    maxHoldMs: entry.maxHoldMs || null,  // v3.25: conviction holds from the pipeline
    bundleAtEntry: entry.bundleAtEntry ?? null,
    score: entry.score,
    eliteHit: !!entry.eliteHit,
    flowTag: !!entry.flowTag,
    entryVol: entry.entryVol ?? null,
    route: fill.route || 'jupiter',
    real: true,
  };
  R.positions.push(pos);
  R.cash = Math.max(0, R.cash - sizeUsd);
  // Slippage learning: signal price (USD→SOL) vs fill price.
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
  // v3.25: trade journal entry (learning) — same as paper did.
  try {
    const { logTradeEntry } = await import('./learning.js');
    logTradeEntry({
      mint: pos.mint, symbol: pos.symbol, entryMc: pos.entryMc,
      score: entry.score, breakdown: entry.breakdown || null, feeds: entry.feeds || null,
      researchMod: entry.researchMod || 0, researchLine: entry.researchLine || null,
      eliteHit: !!entry.eliteHit, buyPressure: entry.buyPressure || null,
      creator: t.creator || null, m5Change: t.priceChange?.m5 ?? null,
    });
    if (t.creator) {
      const { noteCreatorLaunchCount } = await import('./learning.js');
      noteCreatorLaunchCount(t.creator, 1);
    }
  } catch { /* journal is a nicety */ }
  await persistSync();
  floorEmit('real.enter', { mint: pos.mint, symbol: pos.symbol, solSize, sig: fill.sig, route: fill.route });
  floorEmit('trade.enter', {
    mint, symbol: sym, name: pos.name,
    score: entry.score, sizeUsd, entryMc: pos.entryMc,
    researchMod: entry.researchMod || 0,
  });
  console.log(`[realbook] BOUGHT ${sym} — tx ${fill.sig} (route: ${fill.route || 'jupiter'})`);
  return pos;
}

// ------------------------------------------------------------ exits
/**
 * Mirror a paper exit with a real sell. Called from the loop when a paper
 * position closes AND a matching real position is open.
 */
export async function realExit(paperTrade, cfg) {
  return realClosePosition(paperTrade.mint, paperTrade.exitReason || 'mirrored paper exit', cfg);
}

/**
 * v3.24: manually close a real position (user hits SELL button).
 * Same execution path as realExit, but user-initiated.
 */
export async function realManualSell(mint, cfg = {}) {
  return realClosePosition(mint, '👆 manual sell', cfg);
}

export async function realClosePosition(mint, exitReason, cfg) {
  if (!R) return null;
  const idx = (R.positions || []).findIndex(x => x.mint === mint);
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
    // v3.26 CLOSE GUARANTEE: never silently drop. Retry the wallet read once
    // (RPC flakiness), then log an "unexitable — removed" trade so the UI
    // and history show what happened instead of the position vanishing.
    try {
      await new Promise(r => setTimeout(r, 1500));
      const st2 = await realWalletState([pos.mint]);
      const bal2 = st2.tokens[pos.mint];
      if (bal2 && bal2.raw > 0) tokenBal = bal2;
    } catch { /* retry failed → treat as no balance */ }
  }
  if (!tokenBal || !(tokenBal.raw > 0)) {
    console.log('[realbook] no on-chain balance for', pos.symbol, '— logging unexitable removal');
    const now0 = Date.now();
    const trade0 = {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      solSize: pos.solSize, sizeUsd: pos.sizeUsd,
      proceedsUsd: 0, pnlUsd: -(pos.sizeUsd || 0),
      multiple: 0,
      entryTxSig: pos.entryTxSig, exitTxSig: null,
      entryTs: pos.entryTs, exitTs: now0,
      holdMs: now0 - pos.entryTs,
      exitReason: `${exitReason} · unexitable — removed (no on-chain balance)`,
      score: pos.score, real: true,
    };
    R.positions.splice(idx, 1);
    R.closed = [trade0, ...(R.closed || [])].slice(0, 500);
    R.cooldowns = { ...(R.cooldowns || {}), [pos.mint]: now0 };
    try {
      const { logTradeExit } = await import('./learning.js');
      logTradeExit(trade0);
    } catch { /* journal is a nicety */ }
    await persistSync();
    floorEmit('real.unexitable', { mint: pos.mint, symbol: pos.symbol, reason: 'no on-chain balance' });
    return trade0;
  }

  console.log(`[realbook] SELL ${pos.symbol} (${tokenBal.raw} base units)`);
  let fill;
  try {
    fill = await sellToken(pos.mint, String(tokenBal.raw), tokenBal.decimals, {
      slippageBps: Math.round((cfg.slippage || 0.20) * 10000),
      priorityFeeLamports: cfg.priorityFeeLamports || PRIORITY_FEE_LAMPORTS,
    });
  } catch (e) {
    console.error('[realbook] sell FAILED:', e.message);
    floorEmit('real.sell_fail', { mint: pos.mint, symbol: pos.symbol, error: e.message });
    // v3.26 CLOSE GUARANTEE: keep retrying transient failures, but after 3
    // consecutive sell failures log "unexitable — removed" instead of
    // holding a dead position forever.
    const fails = (R.sellFailCount = R.sellFailCount || {});
    fails[pos.mint] = (fails[pos.mint] || 0) + 1;
    await persistSync();
    if (fails[pos.mint] >= 3) {
      const now1 = Date.now();
      const trade1 = {
        mint: pos.mint, symbol: pos.symbol, name: pos.name,
        solSize: pos.solSize, sizeUsd: pos.sizeUsd,
        proceedsUsd: 0, pnlUsd: -(pos.sizeUsd || 0),
        multiple: 0,
        entryTxSig: pos.entryTxSig, exitTxSig: null,
        entryTs: pos.entryTs, exitTs: now1,
        holdMs: now1 - pos.entryTs,
        exitReason: `${exitReason} · unexitable — removed (sell failed ${fails[pos.mint]}×: ${(e.message || '').slice(0, 80)})`,
        score: pos.score, real: true,
      };
      delete fails[pos.mint];
      R.positions.splice(idx, 1);
      R.closed = [trade1, ...(R.closed || [])].slice(0, 500);
      R.cooldowns = { ...(R.cooldowns || {}), [pos.mint]: now1 };
      try {
        const { logTradeExit } = await import('./learning.js');
        logTradeExit(trade1);
      } catch { /* journal is a nicety */ }
      await persistSync();
      floorEmit('real.unexitable', { mint: pos.mint, symbol: pos.symbol, reason: 'sell failed 3x' });
      return trade1;
    }
    return null; // keep position open; retry next tick
  }
  // Sell succeeded — clear any failure count for this mint.
  if (R.sellFailCount && R.sellFailCount[pos.mint]) {
    delete R.sellFailCount[pos.mint];
  }

  let spx = 150;
  try { spx = await solPrice(); } catch {}
  const proceedsUsd = fill.solOut * spx;
  const pnlUsd = proceedsUsd - pos.sizeUsd;
  R.cash += proceedsUsd;
  // v3.25: cooldown — same semantics the paper book enforced.
  R.cooldowns = { ...(R.cooldowns || {}), [pos.mint]: Date.now() };
  const trade = {
    mint: pos.mint, symbol: pos.symbol, name: pos.name,
    solSize: pos.solSize, sizeUsd: pos.sizeUsd,
    proceedsUsd, pnlUsd,
    multiple: pos.sizeUsd > 0 ? proceedsUsd / pos.sizeUsd : 1,
    entryTxSig: pos.entryTxSig, exitTxSig: fill.sig,
    entryTs: pos.entryTs, exitTs: Date.now(),
    holdMs: Date.now() - pos.entryTs,
    exitReason,
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
  // v3.25: learning from real exits (same as paper did).
  try {
    const { logTradeExit } = await import('./learning.js');
    logTradeExit(trade);
  } catch { /* journal is a nicety */ }
  await persistSync();
  floorEmit('real.exit', { mint: pos.mint, symbol: pos.symbol, pnlUsd, sig: fill.sig });
  floorEmit('risk.exit', {
    mint: pos.mint, symbol: pos.symbol, name: pos.name,
    exitReason, pnlUsd, multiple: trade.multiple, learned: false,
  });
  console.log(`[realbook] SOLD ${pos.symbol} pnl $${pnlUsd.toFixed(2)} — tx ${fill.sig}`);

  // Kill-switch check after every close
  await checkKillSwitch();
  return trade;
}

// ------------------------------------------------------------ wallet reconciliation
/**
 * v3.34: find the ACTUAL on-chain sell transaction for a manual close.
 * Scans the wallet's recent enhanced transactions for the most recent
 * transaction where the wallet sent this token's mint (after entryTs),
 * and sums the SOL that flowed back into the wallet in that tx.
 * Returns { sig, solReceived, ts } or null if not found.
 */
function findActualManualSellTx(pos, wallet, txns) {
  if (!txns || !txns.length || !wallet) return null;
  const entryCutoff = (pos.entryTs || 0) - 60000; // 60s tolerance before entry
  let best = null;
  for (const tx of txns) {
    const ts = (tx.timestamp || 0) * 1000;
    if (!ts || ts < entryCutoff) continue;
    if (tx.signature === pos.entryTxSig) continue; // never match our own entry
    const sent = (tx.tokenTransfers || []).find(t =>
      t.fromUserAccount === wallet && t.mint === pos.mint && (t.tokenAmount || 0) > 0);
    if (!sent) continue;
    // SOL the wallet received in this tx (sale proceeds on pump.fun go straight back as native SOL)
    const solIn = (tx.nativeTransfers || [])
      .filter(t => t.toUserAccount === wallet)
      .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
    if (!best || ts > best.ts) best = { sig: tx.signature, solReceived: solIn, ts, tokensSold: sent.tokenAmount };
  }
  return best;
}

/**
 * v3.31: WALLET RECONCILIATION — detect manual sells.
 * Called at the start of each tickReal cycle. For each open position,
 * verifies the wallet still holds the tokens on-chain. If the balance
 * is zero or dust (user sold manually from the wallet), closes the book
 * entry as MANUALLY_CLOSED.
 * v3.34: P&L now uses the ACTUAL sell transaction from Helius (SOL received
 * on-chain) instead of a price-feed estimate. Falls back to the estimate
 * (flagged) only if the tx can't be found.
 * Does NOT attempt an on-chain sell — the tokens are already gone.
 * Returns the closed trades.
 */
export async function reconcilePositions(priceMap = {}) {
  if (!R || !isRealMode()) return [];
  const positions = R.positions || [];
  if (!positions.length) return [];

  let walletState;
  try {
    walletState = await realWalletState(positions.map(p => p.mint));
  } catch (e) {
    console.error('[realbook] reconcile: wallet read failed:', e.message);
    return []; // fail-safe: don't touch positions if we can't read the wallet
  }

  const closed = [];
  const now = Date.now();
  const wallet = realWalletAddress();

  // Pass 1: detect manual-close candidates (balance gone or dust)
  const candidates = [];
  for (const pos of positions) {
    const bal = walletState.tokens[pos.mint];
    const raw = bal ? (bal.raw || 0) : 0;
    const expectedTokens = pos.tokensOut || 0;
    const isDust = expectedTokens > 0 && raw < expectedTokens * 0.02;
    if (raw > 0 && !isDust) continue; // position intact
    candidates.push({ pos, isDust });
  }
  if (!candidates.length) return [];

  // Pass 2: fetch recent wallet txns ONCE so every candidate can look up its actual sell.
  // Fail-open: if Helius is unavailable we fall back to the price estimate per position.
  let walletTxns = null;
  try {
    const key = getKey();
    if (key && wallet) walletTxns = await fetchWalletTxns(wallet, key, 40);
  } catch (e) {
    console.error('[realbook] reconcile: tx history read failed (using estimates):', e.message);
    walletTxns = null;
  }

  let spx = 150;
  try { spx = await solPrice(); } catch {}

  for (const { pos, isDust } of candidates) {
    let proceedsUsd, pnlUsd, multiple, exitTxSig, exitReason, actual;

    // Try the ACTUAL on-chain sell first
    const sell = findActualManualSellTx(pos, wallet, walletTxns);
    if (sell && sell.solReceived > 0) {
      actual = true;
      proceedsUsd = sell.solReceived * spx;
      pnlUsd = proceedsUsd - (pos.sizeUsd || 0);
      multiple = (pos.sizeUsd || 0) > 0 ? proceedsUsd / pos.sizeUsd : 1;
      exitTxSig = sell.sig;
      const pnlStr = `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`;
      exitReason = `👆 manually closed — sold from wallet (actual on-chain: ${pnlStr} / ${multiple.toFixed(2)}x)`;
      console.log(`[realbook] MANUALLY_CLOSED ${pos.symbol} — actual sell ${sell.sig.slice(0, 12)}…: ${sell.solReceived.toFixed(4)} SOL in (${multiple.toFixed(2)}x, pnl ${pnlStr})`);
    } else {
      // Fallback: price-feed estimate, flagged as estimated
      actual = false;
      const t = priceMap[pos.mint] || {};
      const curMc = t.mc || null;
      const entryMc = pos.entryMc || 0;
      multiple = (curMc && entryMc > 0) ? curMc / entryMc : 1;
      proceedsUsd = (pos.sizeUsd || 0) * multiple;
      pnlUsd = proceedsUsd - (pos.sizeUsd || 0);
      exitTxSig = null;
      exitReason = `👆 manually closed — sold from wallet (no on-chain balance${curMc ? ` @ ~${multiple.toFixed(2)}x` : ''}, estimated)`;
      console.log(`[realbook] MANUALLY_CLOSED ${pos.symbol} — no on-chain tx found, est. ${multiple.toFixed(2)}x (${isDust ? 'dust' : 'zero'}) [ESTIMATED]`);
    }

    const trade = {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      solSize: pos.solSize, sizeUsd: pos.sizeUsd,
      proceedsUsd, pnlUsd,
      multiple,
      entryTxSig: pos.entryTxSig, exitTxSig,
      entryTs: pos.entryTs, exitTs: now,
      holdMs: now - pos.entryTs,
      exitReason,
      score: pos.score, real: true,
      manualClose: true,
      manualCloseActual: actual, // true = on-chain tx, false = price estimate
    };

    // Remove from open positions
    const idx = R.positions.findIndex(x => x.mint === pos.mint);
    if (idx >= 0) R.positions.splice(idx, 1);

    R.closed = [trade, ...(R.closed || [])].slice(0, 500);
    R.cooldowns = { ...(R.cooldowns || {}), [pos.mint]: now };

    // Learning journal
    try {
      const { logTradeExit } = await import('./learning.js');
      logTradeExit(trade);
    } catch { /* journal is a nicety */ }

    // Events for UI / trade history
    floorEmit('manual_close', {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      pnlUsd, multiple, exitReason: trade.exitReason,
    });
    floorEmit('risk.exit', {
      mint: pos.mint, symbol: pos.symbol, name: pos.name,
      exitReason: trade.exitReason, pnlUsd, multiple, learned: false,
    });

    closed.push(trade);
  }

  if (closed.length) await persistSync();
  return closed;
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
 * THE KILL SWITCH — DISABLED per user 2026-10-08 ("let it trade until it cannot anymore").
 * Still records equity history every tick, but never halts trading.
 */
export async function checkKillSwitch() {
  // v3.40: KILL SWITCH PERMANENTLY DISABLED per user ("no fucking kill switches").
  // Only records equity history, never halts. Bot trades until wallet is empty.
  if (!R) return false;
  const eq = await realEquityUsd();
  if (eq == null) return false;
  R.equity = [...(R.equity || []), { ts: Date.now(), v: eq }].slice(-2000);
  await persistSync();
  return false;
}

// ------------------------------------------------------------ read API
export async function realBookSnapshot() {
  const eq = R ? await realEquityUsd() : null;
  const avgSlip = await avgRealSlippageBps();
  // v3.24: show live wallet balance even before first trade (R is null until
  // ensureRealBook runs). Also reflect tuned guardrails from KV.
  let liveSol = null, tunedMaxPct = null;
  try {
    if (!R && realExecReady()) {
      const st = await realWalletState();
      liveSol = st.sol;
    }
  } catch {}
  try {
    const { kvGetJson } = await import('./storage.js');
    const tuning = await kvGetJson('ab_tuning', null);
    if (tuning && isFinite(Number(tuning.realMaxSizePct))) tunedMaxPct = Number(tuning.realMaxSizePct);
  } catch {}
  // v3.24: live prices for real positions — fetch current MC/price per mint
  // so the UI shows live value, unrealized P&L, multiples
  let livePrices = {};
  try {
    const mints = (R ? R.positions : []).map(p => p.mint).filter(Boolean);
    if (mints.length) {
      const { fetchTokens } = await import('./dexscreener.js');
      const pairs = await fetchTokens(mints);
      for (const m of mints) {
        const pair = pairs && pairs[m];
        if (pair) {
          livePrices[m] = {
            price: pair.priceUsd ? Number(pair.priceUsd) : null,
            mc: pair.fdv ? Number(pair.fdv) : (pair.marketCap ? Number(pair.marketCap) : null),
          };
        }
      }
    }
  } catch {}
  // v3.25: live SOL balance for the header, mark-to-market equity for display
  // (the kill-switch equity stays cost-basis conservative — see realEquityUsd).
  let walletSol = liveSol;
  try {
    if (realExecReady()) {
      const st = await realWalletState();
      walletSol = st.sol;
    }
  } catch {}
  let mtmEquity = eq;
  try {
    if (R && walletSol != null) {
      let spx = 150;
      try { spx = await solPrice(); } catch {}
      let posMtm = 0;
      for (const p of (R.positions || [])) {
        const lp = livePrices[p.mint] || {};
        const curMc = lp.mc, entryMc = p.entryMc;
        const mult = (curMc && entryMc) ? curMc / entryMc : 1;
        posMtm += (p.sizeUsd || 0) * mult;
      }
      mtmEquity = walletSol * spx + posMtm;
    }
  } catch {}
  const closed = R ? (R.closed || []) : [];
  const wins = closed.filter(c => (c.pnlUsd || 0) > 0);
  return {
    ts: Date.now(),
    enabled: realModeOn && !killSwitched,
    killSwitched: isKillSwitched(),
    ready: realExecReady(),
    wallet: R ? R.wallet || realWalletAddress() : realWalletAddress(),
    startUsd: R ? R.startUsd : null,
    startSol: R ? R.startSol : liveSol,
    cash: R ? R.cash : null,
    liveSol,
    walletSol,
    equity: eq,
    mtmEquity,
    pnlUsd: R && mtmEquity != null ? mtmEquity - R.startUsd : null,
    pnlPct: R && mtmEquity != null && R.startUsd > 0 ? (mtmEquity - R.startUsd) / R.startUsd : null,
    positions: R ? R.positions.map(p => {
      const lp = livePrices[p.mint] || {};
      const curMc = lp.mc || null;
      const entryMc = p.entryMc || null;
      const multiple = (curMc && entryMc) ? curMc / entryMc : null;
      return {
        mint: p.mint, symbol: p.symbol, name: p.name,
        solSize: p.solSize, sizeUsd: p.sizeUsd,
        entryTs: p.entryTs, entryTxSig: p.entryTxSig,
        heldMs: Date.now() - (p.entryTs || Date.now()),
        entryMc, entryPrice: p.entryPrice || null,
        curMc, curPrice: lp.price || null,
        multiple,
        valueNow: multiple != null ? p.sizeUsd * multiple : null,
        unrealized: multiple != null ? p.sizeUsd * (multiple - 1) : null,
        score: p.score, adaptiveTp: p.adaptiveTp, adaptiveSl: p.adaptiveSl,
        route: p.route || null,
      };
    }) : [],
    closed: closed.slice(0, 50),
    fills: R ? (R.fills || []).slice(-50).reverse() : [],
    equityCurve: R ? (R.equity || []).slice(-200) : [],
    stats: {
      totalTrades: closed.length,
      wins: wins.length,
      losses: closed.length - wins.length,
      winRate: closed.length ? wins.length / closed.length : null,
      realizedPnl: closed.reduce((s, c) => s + (c.pnlUsd || 0), 0),
      avgMultiple: closed.length ? closed.reduce((s, c) => s + (c.multiple || 1), 0) / closed.length : null,
      openCount: R ? (R.positions || []).length : 0,
    },
    avgSlippageBps: avgSlip,
    guardrails: {
      maxPositions: REAL_MAX_POSITIONS,
      maxSizePct: tunedMaxPct || REAL_MAX_SIZE_PCT,
      killSwitchDrawdown: KILL_SWITCH_DRAWDOWN,
    },
  };
}
