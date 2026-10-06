// ALPHABOT backend — pipeline loop orchestrator.
// Runs the desk server-side: 45s SCAN→VET→RESEARCH→SCORE→TRADE cycle,
// 20s price tick (RISK exits), slow kill-confirmation pass, and the
// smart-flow watcher (Helius). Paper money only. Fail-open everywhere.

import { loadConfig } from '../lib/config.js';
import { initStorage, storage } from '../lib/storage.js';
import { scanTokens, vetToken, scoreToken } from '../lib/pipeline.js';
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
import { probePumpPortal, pumpPortalState } from '../lib/pumpportal.js';
import { recentEvents, floorEmit } from '../lib/events.js';

const VET_PER_CYCLE = 25;
const RUG_PER_CYCLE = 8;
const RESEARCH_PER_CYCLE = 4;
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
    floorEmit('scan.done', { discovered, queued: Q.vet.size });

    // VET: kill chain (free → trade → rug, ascending cost) via vetToken.
    // Kills go to the kill ledger + signal log; survivors queue for research.
    for (const t of Q.vet.drain(VET_PER_CYCLE)) {
      try {
        const r = await vetToken(t, cfg);
        if (r.verdict === 'KILLED') {
          cycleStats.killed++;
          logKill(t, r.killPass, r.killReason);
          processResult(p, r, cfg, { silent: false });
        } else {
          Q.research.push({ ...t, dossier: r.dossier, score: r.score, breakdown: r.breakdown, adapted: r.adapted });
        }
      } catch { cycleStats.errors++; }
    }

    // RESEARCH + JUDGE + final scoring (slow, few per cycle).
    const elite = await refreshElite();
    // SOL price once per cycle for SOL-denominated sizing (cached 2m server-side).
    let spx = null;
    try { spx = await solPrice(); } catch { spx = null; }
    let judged = 0;
    for (const item of Q.research.drain(RESEARCH_PER_CYCLE)) {
      try {
        const research = await researchToken(item, item.dossier);
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
      for (const m of mints) {
        const t = tokenView(raw[m]);
        if (t) priceMap[m] = { price: t.price, mc: t.mc, vol24h: t.vol24h };
      }
    }
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
      whaleMcUsd: cfg.whaleMcUsd, whaleTurnoverMin: cfg.whaleTurnoverMin, whaleSolSize: cfg.whaleSolSize,
      earlyMcUsd: cfg.earlyMcUsd, earlyMinScore: cfg.earlyMinScore, earlySolSize: cfg.earlySolSize,
      maxPositions: cfg.maxPositions,
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
  await initLearning();
  await initPortfolio(cfg);
  probePumpPortal();

  // Smart-flow watcher (dormant without HELIUS_API_KEY).
  startFlowWatch((mint) => injectMint(mint, 'flow'));

  // Kick off immediately, then on interval.
  scanCycle().catch(() => {});
  setInterval(() => { scanCycle().catch(() => {}); }, Math.max(20, cfg.scanIntervalSec) * 1000);
  priceTick().catch(() => {});
  setInterval(() => { priceTick().catch(() => {}); }, Math.max(10, cfg.priceIntervalSec) * 1000);
  console.log('[loop] started — scan every', cfg.scanIntervalSec + 's, price tick every', cfg.priceIntervalSec + 's');
}
