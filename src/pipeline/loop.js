// ALPHABOT backend — pipeline loop orchestrator.
// Runs the desk server-side: 45s SCAN→VET→RESEARCH→SCORE→TRADE cycle,
// 20s price tick (RISK exits), slow kill-confirmation pass, and the
// smart-flow watcher (Helius). Paper money only. Fail-open everywhere.

import { loadConfig, applyAggressive } from '../lib/config.js';
import { initStorage, storage, kvGetJson, kvSetJson } from '../lib/storage.js';
import { scanTokens, vetToken, scoreToken, heatOf } from '../lib/pipeline.js';
import { researchToken } from '../lib/research.js';
import { judgeToken, getJudgeStats } from '../lib/aiJudge.js';
import { warmCalloutCache } from '../lib/callouts.js';
import { Q, queueStats } from '../lib/queues.js';
import { fetchTokens, solPrice } from '../lib/dexscreener.js';
import { ELITE } from '../lib/elite.js';
import { getKey as heliusKey, fetchWalletTxns, parseSwaps } from '../lib/helius.js';
import {
  initPortfolio, getPortfolio, processResult, tick,
  snapshotEquity, statsFor,
} from '../lib/paper.js';
import { initLearning, logKill, confirmKills, getBrainStats } from '../lib/learning.js';
import { getExitRules } from '../lib/exits.js';
import { startFlowWatch, getFlowStats } from '../lib/flowWatch.js';
import { startNewPoolsWatch, getNewPoolsStats } from '../lib/geckoterminal.js';
import { fetchDbcPrices } from '../lib/meteora.js';
import { probePumpPortal, pumpPortalState } from '../lib/pumpportal.js';
import { recentEvents, floorEmit } from '../lib/events.js';

const VET_PER_CYCLE = 25;
const RUG_PER_CYCLE = 8;
const RESEARCH_PER_CYCLE = 6;   // v3.10: wider net — was 4
const JUDGE_PER_CYCLE = 3;
const DEDUP_MS = 90 * 60 * 1000;

const seenMints = new Map(); // mint -> ts (90-min pipeline dedupe)
let lastFeedRows = { new: [], trending: [], movers: [] };
let priceMap = {};
let eliteCache = { ts: 0, buyers: new Map(), swaps: {} };
const ELITE_TTL = 120000;

export const cycleStats = {
  startedAt: Date.now(),
  cycles: 0,
  lastCycleTs: 0,
  lastCycleMs: 0,
  discovered: 0,
  killed: 0,
  scored: 0,
  entries: 0,
  exits: 0,
  errors: 0,
  pumpApiOk: null,
  pumpPortal: 'idle',
};

let cfg = null;

function pruneSeen() {
  const now = Date.now();
  for (const [k, ts] of seenMints) {
    if (now - ts > DEDUP_MS) seenMints.delete(k);
  }
}

// Elite confirmation: once per cycle (cached 2 min), parse recent swaps of
// the 15 elite wallets into mint→buyers + per-wallet sells for the exit rule.
async function refreshElite() {
  const key = heliusKey();
  if (!key) return eliteCache;
  if (Date.now() - eliteCache.ts < ELITE_TTL) return eliteCache;
  const buyers = new Map();
  const swaps = {};
  await Promise.all(ELITE.map(async ({ address }) => {
    try {
      const txns = await fetchWalletTxns(address, key, 10);
      const { buys, sells } = parseSwaps(txns, address);
      for (const b of buys) {
        if (!buyers.has(b.mint)) buyers.set(b.mint, []);
        buyers.get(b.mint).push(address);
      }
      swaps[address] = { label: 'elite', sells: sells.map(s => ({ mint: s.mint, ts: s.ts })) };
    } catch { /* one wallet failing is fine */ }
  }));
  eliteCache = { ts: Date.now(), buyers, swaps };
  return eliteCache;
}

function injectMint(mint, source) {
  if (!mint || seenMints.has(mint)) return;
  seenMints.set(mint, Date.now());
  fetchTokens([mint]).then(async (raw) => {
    const pair = raw[mint];
    if (!pair) return;
    const { tokenView } = await import('../lib/dexscreener.js');
    const t = tokenView(pair);
    if (t && t.price && t.mc) {
      Q.vet.unshiftFront([{ ...t, source: source || 'flow', feeds: ['new'] }]);
      floorEmit('flow.mint', { mint, symbol: t.symbol, name: t.name });
    }
  }).catch(() => {});
}

// v3.20: GeckoTerminal new-pools injection. Launches carry live price + FDV
// (pre-DexScreener), so they go straight to the vet queue.
function injectNewPool(launch) {
  if (!launch || !launch.mint || seenMints.has(launch.mint)) return;
  seenMints.set(launch.mint, Date.now());
  const isDbc = launch.dex === 'meteora-dbc';
  const t = {
    address: launch.mint,
    name: launch.name || 'Unknown',
    symbol: launch.symbol || '???',
    image: null,
    price: launch.price || null,
    fdv: launch.mc || null,
    mc: launch.mc || null,
    supply: null,
    liquidity: null,          // too new for reliable liq — on-curve treated as liquid
    vol24h: null,              // too new for 24h volume — skips the vol floor
    buys24h: null,
    sells24h: null,
    createdAt: launch.createdAt || Date.now(),
    dex: launch.dex || null,
    url: null,
    priceChange: null,
    graduated: false,          // fresh pools are pre-graduation
    _dbc: isDbc,               // DBC-native: on-chain price refresh available
    _dbcPool: isDbc ? (launch.pool || null) : null,
    _dbcQuote: null,
    _gt: true,                 // GeckoTerminal-sourced: skips vol floor
    source: 'geckoterminal',
    feeds: ['new'],
  };
  Q.vet.unshiftFront([t]);
  cycleStats.discovered++;
  floorEmit('flow.mint', { mint: launch.mint, symbol: t.symbol, name: t.name });
}

async function scanCycle() {
  const t0 = Date.now();
  const p = getPortfolio();
  try {
    pruneSeen();
    warmCalloutCache();
    const { candidates, discovered, feedRows } = await scanTokens();
    cycleStats.discovered += discovered;
    if (feedRows) lastFeedRows = feedRows;
    // pumpApiOk re-checks every cycle (the old sticky-first-cycle flag lied
    // after a cold-start failure and showed the feed as dead forever).
    cycleStats.pumpApiOk = candidates.some(c => c.source === 'pump-api');
    for (const c of candidates) {
      if (seenMints.has(c.address)) continue;
      seenMints.set(c.address, Date.now());
      Q.vet.push(c);
    }
    // v3.23: movers strategy — inject detected movers (dip/breakout/momentum)
    // into the vet queue. They bypass seenMints (re-evaluated each cycle).
    try {
      const { getMovers } = await import('../lib/movers.js');
      const { fetchTokens: fetchDsTokens, tokenView } = await import('../lib/dexscreener.js');
      const movers = getMovers();
      if (movers.length) {
        const raw = await fetchDsTokens(movers.map(m => m.mint));
        for (const m of movers) {
          const pair = raw[m.mint];
          const full = pair ? tokenView(pair) : null;
          if (!full || !full.mc) continue;
          Q.vet.push({
            ...full, address: m.mint,
            moverSetup: m.setup, moverChangePct: m.changePct,
            moverDipPct: m.dipFromPeak,
            source: 'movers', feeds: ['movers'],
          });
        }
      }
    } catch { /* movers is additive */ }
    floorEmit('scan.done', { discovered, queued: Q.vet.size });

    // VET: kill chain (free → trade → rug, ascending cost) via vetToken.
    // Kills go to the kill ledger + signal log; survivors queue for research.
    // v3.23: parallel batches of 5 — analyze multiple coins at once, not 1 by 1.
    const vetBatch = Q.vet.drain(VET_PER_CYCLE);
    for (let i = 0; i < vetBatch.length; i += 5) {
      const chunk = vetBatch.slice(i, i + 5);
      const results = await Promise.allSettled(chunk.map(t => vetToken(t, cfg)));
      for (let j = 0; j < chunk.length; j++) {
        const t = chunk[j];
        const settled = results[j];
        if (settled.status !== 'fulfilled') { cycleStats.errors++; continue; }
        try {
          const r = settled.value;
          if (r.verdict === 'KILLED') {
            cycleStats.killed++;
            logKill(t, r.killPass, r.killReason);
            processResult(p, r, cfg, { silent: false });
          } else {
            Q.research.push({ ...t, dossier: r.dossier, score: r.score, breakdown: r.breakdown, adapted: r.adapted });
          }
        } catch { cycleStats.errors++; }
      }
    }

    // RESEARCH + JUDGE + final scoring (slow, few per cycle).
    const elite = await refreshElite();
    // Heat triage: hottest first — bad coins don't waste the research budget.
    try { Q.research.sortBy(heatOf); } catch { /* fifo */ }
    // SOL price once per cycle for SOL-denominated sizing (cached 2m server-side).
    let spx = null;
    try { spx = await solPrice(); } catch { spx = null; }
    let judged = 0;
    for (const item of Q.research.drain(RESEARCH_PER_CYCLE)) {
      try {
        const research = await researchToken(item, item.dossier, cfg);
        let judgeMod = 0, judgeLine = null;
        if (judged < JUDGE_PER_CYCLE) {
          const j = await judgeToken(item, item.dossier, research);
          judgeMod = j.modifier; judgeLine = j.line;
          if (j.verdict) judged++;
        }
        const { score, breakdown, adapted } = item.score != null
          ? { score: item.score, breakdown: item.breakdown, adapted: item.adapted }
          : scoreToken(item, item.dossier, cfg);
        const eliteHit = elite.buyers.has(item.address);
        const r = {
          verdict: 'SCORED', score, breakdown, dossier: item.dossier, t: item,
          researchMod: research.modifier, researchLine: research.line,
          calloutLine: research.calloutLine,
          judgeMod, judgeLine,
          eliteHit, flowTag: (item.feeds || []).includes('new') && item.source === 'flow',
          adapted: adapted || item.adapted,
        };
        cycleStats.scored++;
        const { entered } = processResult(p, r, cfg, { silent: false, solPrice: spx });
        if (entered) cycleStats.entries++;
      } catch { cycleStats.errors++; }
    }

    // Slow pass: confirm a few open kills per cycle (feeds the kill ledger).
    try { await confirmKills(); } catch { /* nicety */ }

    cycleStats.cycles++;
    cycleStats.lastCycleTs = Date.now();
    cycleStats.lastCycleMs = Date.now() - t0;
    cycleStats.pumpPortal = pumpPortalState();
  } catch (e) {
    cycleStats.errors++;
    console.error('[loop] scan cycle failed:', e.message);
  }
}

async function priceTick() {
  const p = getPortfolio();
  if (!p) return;
  try {
    const mints = [...new Set([
      ...(p.positions || []).map(x => x.mint),
      ...(p.signals || []).slice(0, 30).map(s => s.mint).filter(Boolean),
    ])].filter(Boolean);
    if (mints.length) {
      const raw = await fetchTokens(mints);
      const { tokenView } = await import('../lib/dexscreener.js');
      // v3.23: pump.fun fallback for fresh coins DexScreener hasn't indexed yet
      const needPf = [];
      for (const m of mints) {
        const t = tokenView(raw[m]);
        if (!t || !t.mc) needPf.push(m);
      }
      let pfPrices = {};
      if (needPf.length) {
        try {
          const { fetchPumpPrices } = await import('../lib/pumpfun.js');
          pfPrices = await fetchPumpPrices(needPf);
        } catch { /* fallback is best-effort */ }
      }
      for (const m of mints) {
        const t = tokenView(raw[m]);
        if (t && t.mc > 0) {
          priceMap[m] = { price: t.price, mc: t.mc, vol24h: t.vol24h, buys24h: t.buys24h, sells24h: t.sells24h, liquidity: t.liquidity, src: 'ds' };
        } else if (pfPrices[m] && pfPrices[m] > 0) {
          priceMap[m] = { price: null, mc: pfPrices[m], vol24h: 0, liquidity: 0, src: 'pf' };
        } else if (raw[m]) {
          // DexScreener knows the token but reports no price/MC = dead.
          // Record explicit zero so the sweeper closes it immediately.
          priceMap[m] = { price: 0, mc: 0, vol24h: 0, liquidity: 0, src: 'dead' };
        }
      }
    }
    // v3.20: bundle distribution check — every 5 min, re-fetch dossier for
    // positions that had a bundle at entry. If bundle % dropped 30%+, the
    // overhang is clearing = bullish, extend hold. If still heavy, tighten.
    try {
      const now = Date.now();
      if (!priceTick._lastBundle || now - priceTick._lastBundle > 300000) {
        priceTick._lastBundle = now;
        const { fetchRugReport } = await import('../lib/pumpfun.js');
        for (const pos of (p.positions || []).filter(x => x.bundleAtEntry > 5)) {
          const d = await fetchRugReport(pos.mint);
          if (d && d.bundlePct != null) {
            const drop = pos.bundleAtEntry - d.bundlePct;
            pos.bundleNow = d.bundlePct;
            if (drop >= pos.bundleAtEntry * 0.3) {
              // Bundle distributing — extend hold by 1h, loosen trailing.
              pos.maxHoldMs = (pos.maxHoldMs || 5400000) + 3600000;
              pos.bundleDistributing = true;
            }
          }
        }
      }
    } catch {}
    // v3.20: on-chain price refresh for DBC positions (pre-DexScreener).
    // DexScreener lags new DBC pools by minutes; the curve doesn't.
    try {
      const dbcPositions = (p.positions || []).filter(x => x._dbcPool && x.mint);
      if (dbcPositions.length && heliusKey()) {
        const dbcPrices = await fetchDbcPrices(
          heliusKey(),
          dbcPositions.map(x => ({ mint: x.mint, pool: x._dbcPool, quoteMint: x._dbcQuote }))
        );
        for (const m of Object.keys(dbcPrices)) {
          const q = dbcPrices[m];
          priceMap[m] = { ...(priceMap[m] || {}), price: q.price, mc: q.mc };
        }
      }
    } catch { /* DBC refresh is a nicety */ }
    const elite = await refreshElite();
    const closed = tick(p, priceMap, elite.swaps, cfg);
    if (closed.length) cycleStats.exits += closed.length;
    snapshotEquity(p, priceMap);
  } catch (e) {
    cycleStats.errors++;
    console.error('[loop] price tick failed:', e.message);
  }
}

export function getStateSnapshot() {
  const p = getPortfolio();
  const stats = p ? statsFor(p, priceMap) : null;
  let brain = null, exitRules = null;
  try { brain = getBrainStats(); } catch { /* noop */ }
  try {
    const r = getExitRules(cfg);
    exitRules = {
      ready: r.ready, n: r.n,
      runner: r.runner, deadCut: r.deadCut,
      buckets: r.buckets,
    };
  } catch { /* noop */ }
  return {
    ts: Date.now(),
    config: cfg ? {
      minTokenScore: cfg.minTokenScore, takeProfit: cfg.takeProfit,
      stopLoss: cfg.stopLoss, trailingStop: cfg.trailingStop,
      bankrollSol: cfg.bankrollSol,
      maxMc: cfg.maxMc, pumpMaxMc: cfg.pumpMaxMc, minAgeMin: cfg.minAgeMin,
      maxHoldHours: cfg.maxHoldHours,
      solSizeBase: cfg.solSizeBase, solSizeMid: cfg.solSizeMid, solSizeTop: cfg.solSizeTop,
      maxPositions: cfg.maxPositions,
      aggressiveMode: !!cfg.aggressiveMode, pumpMinMc: cfg.pumpMinMc,
      rugShield: isRugShieldOn(),
    } : null,
    portfolio: p ? {
      bankroll0: p.bankroll0, cash: p.cash,
      equity: (p.equity || []).slice(-200),
      positions: p.positions || [],
      closed: (p.closed || []).slice(0, 50),
      signals: (p.signals || []).slice(0, 80),
    } : null,
    stats,
    feeds: lastFeedRows,
    brain,
    exitRules,
    events: recentEvents(80),
    queues: queueStats(),
    flow: getFlowStats(),
    newpools: getNewPoolsStats(),
    judge: getJudgeStats(),
    cycle: { ...cycleStats },
    keys: {
      helius: Boolean(heliusKey()),
      openai: Boolean((process.env.OPENAI_API_KEY || '').trim()),
      db: Boolean(process.env.DATABASE_URL),
    },
  };
}

export function getClosedTrades(limit = 50) {
  const p = getPortfolio();
  return ((p && p.closed) || []).slice(0, Math.min(200, Math.max(1, limit)));
}

export async function startLoop() {
  cfg = loadConfig();
  console.log('[loop] config loaded (scalp retune): TP', cfg.takeProfit, 'SL', cfg.stopLoss, 'trail', cfg.trailingStop, 'maxHold', cfg.maxHoldHours + 'h');
  await initStorage();
  // v3.18: restore aggressive mode from KV (survives restarts).
  try {
    const saved = await kvGetJson('ab_aggressive', null);
    if (saved && saved.on) applyAggressive(cfg, true);
    else if (cfg.aggressiveMode) applyAggressive(cfg, true);
  } catch {}
  // v3.20: restore rug shield state from KV (survives restarts). Default ON.
  try {
    const rs = await kvGetJson('ab_rugshield', null);
    if (rs && rs.on === false) cfg.skipRugKill = true;
  } catch {}
  try {
    const tuning = await kvGetJson('ab_tuning', null);
    if (tuning && typeof tuning === 'object') applyTuningPatch(cfg, tuning);
  } catch {}
  console.log('[loop] aggressive mode:', cfg.aggressiveMode ? 'ON' : 'off');
  await initLearning();
  await initPortfolio(cfg);
  probePumpPortal();

  // Smart-flow watcher (dormant without HELIUS_API_KEY).
  startFlowWatch((mint) => injectMint(mint, 'flow'));

  // v3.20: GeckoTerminal new-pools feed — all launchpads, 30s poll.
  startNewPoolsWatch((launch) => injectNewPool(launch));

  // Kick off immediately, then on interval.
  scanCycle().catch(() => {});
  setInterval(() => { scanCycle().catch(() => {}); }, Math.max(20, cfg.scanIntervalSec) * 1000);
  priceTick().catch(() => {});
  setInterval(() => { priceTick().catch(() => {}); }, Math.max(10, cfg.priceIntervalSec) * 1000);
  console.log('[loop] started — scan every', cfg.scanIntervalSec + 's, price tick every', cfg.priceIntervalSec + 's');
}

// v3.18: aggressive mode runtime toggle. Mutates the live cfg and persists
// to KV so it survives restarts. Called by POST /api/mode.
export async function setAggressiveMode(on) {
  on = !!on;
  if (!cfg) cfg = loadConfig();
  if (on) {
    applyAggressive(cfg, true);
  } else {
    const fresh = loadConfig();
    // restore non-aggressive values for the overridden keys
    cfg.aggressiveMode = false;
    cfg.minTokenScore = fresh.minTokenScore;
    cfg.pumpMinMc = fresh.pumpMinMc;
    cfg.cooldownMin = fresh.cooldownMin;
    delete cfg.skipRugKill;
    delete cfg.skipSocialCheck;
    delete cfg.skipMintFreezeKill;
  }
  try { await kvSetJson('ab_aggressive', { on, ts: Date.now() }); } catch {}
  console.log('[loop] aggressive mode:', on ? 'ON' : 'off');
  return { aggressiveMode: cfg.aggressiveMode, minTokenScore: cfg.minTokenScore, pumpMinMc: cfg.pumpMinMc };
}

export function isAggressive() {
  return !!(cfg && cfg.aggressiveMode);
}

// v3.20: rug shield toggle — user-facing switch for the RugCheck kill chain.
// on=true (default): rug/dev/holder-concentration kills active.
// on=false: skipRugKill — coins flow to scoring regardless of RugCheck.
export async function setRugShield(on) {
  on = !!on;
  if (!cfg) cfg = loadConfig();
  if (on) delete cfg.skipRugKill;
  else cfg.skipRugKill = true;
  try { await kvSetJson('ab_rugshield', { on, ts: Date.now() }); } catch {}
  console.log('[loop] rug shield:', on ? 'ON' : 'OFF');
  return { rugShield: on };
}

export function isRugShieldOn() {
  return !(cfg && cfg.skipRugKill);
}

// v3.19: live tuning patch from the control panel. Whitelisted keys only —
// applied to the running config and persisted to KV so it survives restarts.
const TUNABLE_KEYS = [
  'maxMc', 'pumpMaxMc', 'minMc', 'pumpMinMc',
  'minTokenScore', 'takeProfit', 'stopLoss', 'trailingStop',
  'maxPositions', 'cooldownMin', 'minVol24hUsd', 'solSizeBase', 'solSizeMid', 'solSizeTop',
  'maxDevPct', 'maxTopHolderPct', 'maxTop10Pct', 'maxHoldHours', // v3.20: smart shield tuning
];
export function applyTuningPatch(target, patch) {
  const applied = {};
  for (const k of TUNABLE_KEYS) {
    if (patch && patch[k] !== undefined) {
      const n = Number(patch[k]);
      if (isFinite(n) && n >= 0) { target[k] = n; applied[k] = n; }
    }
  }
  return applied;
}
export async function patchTuning(patch) {
  if (!cfg) cfg = loadConfig();
  const applied = applyTuningPatch(cfg, patch);
  try {
    const prev = (await kvGetJson('ab_tuning', null)) || {};
    await kvSetJson('ab_tuning', { ...prev, ...applied, ts: Date.now() });
  } catch {}
  console.log('[loop] tuning patched:', JSON.stringify(applied));
  return { ok: true, applied, config: tuningSnapshot() };
}
function tuningSnapshot() {
  const s = {};
  for (const k of TUNABLE_KEYS) s[k] = cfg[k];
  s.aggressiveMode = !!cfg.aggressiveMode;
  return s;
}
export function getTuning() {
  if (!cfg) cfg = loadConfig();
  return tuningSnapshot();
}

// v3.19: fund the paper bankroll (default 1 SOL). Fresh cash + equity curve,
// past closed trades carry over, learning ledgers untouched.
export async function fundBankroll(sol) {
  const { resetPortfolio } = await import('../lib/paper.js');
  let spx = 150;
  try { spx = await solPrice(); } catch { /* fallback */ }
  const out = await resetPortfolio(sol || 1, spx);
  return { ok: true, ...out, solPrice: spx };
}
