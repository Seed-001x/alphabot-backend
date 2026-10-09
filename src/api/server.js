// ALPHABOT backend — Express API entrypoint.
// Read-only state API (CORS open for the GitHub Pages frontend).
// Paper trading is the default. Real-money mode (v3.24) is opt-in via
// tuning {realMode: true} + REAL_WALLET_KEY env — separate book, never mixed.

import express from 'express';
import { pool, hasDb } from '../db/pool.js';
import { startLoop, getStateSnapshot, getClosedTrades, cycleStats, setAggressiveMode, isAggressive, setRugShield, isRugShieldOn, fundBankroll, patchTuning, getTuning } from '../pipeline/loop.js';
import { getBrainStats, resetLearning } from '../lib/learning.js';
import { getExitRules } from '../lib/exits.js';
import { loadConfig } from '../lib/config.js';
import { getJudgeStats } from '../lib/aiJudge.js';
import { recentEvents } from '../lib/events.js';
import { liveFeedStatus } from '../lib/livefeed.js';

const PORT = Number(process.env.PORT || 3000);
const app = express();

// CORS — the GitHub Pages frontend calls this API from browsers.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '256kb' }));

// Express 4 does not catch errors in async handlers — wrap them.
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) =>
    orig(path, ...handlers.map((h) => (req, res, next) =>
      Promise.resolve(h(req, res, next)).catch(next)));
}

// ---------------------------------------------------------------- health
app.get('/health', async (req, res) => {
  let db = false;
  if (hasDb) {
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch { /* db unreachable */ }
  }
  res.json({
    ok: true,
    ts: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    db,
    helius: Boolean((process.env.HELIUS_API_KEY || '').trim()),
    openai: Boolean((process.env.OPENAI_API_KEY || '').trim()),
    cycles: cycleStats.cycles,
    lastCycleTs: cycleStats.lastCycleTs,
    mode: 'real-only', // v3.25: paper trading removed
    livefeed: (() => { try { return liveFeedStatus(); } catch { return null; } })(),
  });
});

// ---------------------------------------------------------------- state
// Full snapshot for the frontend "backend mode": portfolio, positions,
// stats, feeds, brain, events, queues, cycle counters.
app.get('/api/state', async (req, res) => {
  res.json(getStateSnapshot());
});

// Aggressive mode toggle (v3.18). POST {on: true/false} — flips the live
// config, persists to KV. The frontend calls this from the AGGRESSIVE button.
app.post('/api/mode', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    const out = await setAggressiveMode(on);
    res.json({ ok: true, ts: Date.now(), ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.20: rug shield toggle (POST {on: true/false}).
app.post('/api/rugshield', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    const out = await setRugShield(on);
    res.json({ ok: true, ts: Date.now(), ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.25: paper bankroll removed — the bot is real-only. Kept as an endpoint
// so old callers get a clear error instead of a 404.
app.post('/api/bankroll', async (req, res) => {
  res.status(410).json({ ok: false, error: 'paper trading removed in v3.25 — bot is real-only' });
});

// v3.19: live tuning from the control panel (POST {patch: {maxMc: 500000}}).
// Whitelisted keys only; applied live and persisted to KV.
app.get('/api/tuning', async (req, res) => {
  res.json({ ok: true, ts: Date.now(), tuning: getTuning() });
});
app.post('/api/tuning', async (req, res) => {
  try {
    const out = await patchTuning((req.body && req.body.patch) || {});
    res.json({ ok: true, ts: Date.now(), ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// Closed paper trades, newest first.
app.get('/api/trades', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ts: Date.now(), trades: getClosedTrades(limit) });
});

// v3.24: real-money book — separate from paper. Read-only snapshot.
// Never exposes the private key (only the public wallet address).
app.get('/api/realbook', async (req, res) => {
  try {
    const { realBookSnapshot } = await import('../lib/realbook.js');
    const snap = await realBookSnapshot();
    let livefeed = null;
    try { livefeed = liveFeedStatus(); } catch {}
    res.json({ ok: true, ...snap, livefeed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.27: live pump.fun movers feed for the frontend Opportunities tab.
// v3.28: enriched with terminal data (holders, vol24h, priceUsd, txns24h)
// for the top 30 by MC. Enrichment is display-only and fail-open.
// v3.29: graduated PumpSwap runners merged in (tagged graduated: true) so
// the tab shows the same post-graduation movers the bot now tracks.
app.get('/api/movers', async (req, res) => {  try {
    const { fetchPumpMovers, fetchPumpSwapGraduated } = await import('../lib/pumpfun.js');
    const [movers, graduated] = await Promise.all([
      fetchPumpMovers(60),
      fetchPumpSwapGraduated(40),
    ]);
    const seen = new Set(movers.map(c => c.address));
    const coins = [...movers];
    for (const g of graduated) {
      if (!seen.has(g.address)) { seen.add(g.address); coins.push(g); }
    }
    // Top 30 by MC for enrichment (controls API cost)
    const sorted = [...coins].sort((a, b) => (b.usdMc || 0) - (a.usdMc || 0));
    let enriched;
    try {
      const { enrichMovers } = await import('../lib/moversenrich.js');
      enriched = await enrichMovers(sorted);
    } catch { enriched = sorted.slice(0, 30); }
    res.json({ ok: true, coins: enriched, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.30: token registry diagnostics — table status, counts, sample records.
// Used to verify the persistent registry survives deploys.
app.get('/api/registry', async (req, res) => {
  try {
    const { pool, hasDb } = await import('../db/pool.js');
    const { registrySize } = await import('../lib/registry.js');
    if (!hasDb) {
      return res.json({ ok: true, db: false, cacheSize: registrySize() });
    }
    const tables = {};
    for (const t of ['ab_tokens', 'ab_token_observations', 'ab_evaluations']) {
      try {
        const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
        tables[t] = Number(rows[0].n);
      } catch (e) {
        tables[t] = 'missing: ' + e.message.slice(0, 80);
      }
    }
    let sample = [];
    try {
      const { rows } = await pool.query(
        `SELECT mint, symbol, lifecycle_state, venue, vet_count, last_seen
         FROM ab_tokens ORDER BY updated_at DESC LIMIT 5`
      );
      sample = rows;
    } catch {}
    res.json({ ok: true, db: true, cacheSize: registrySize(), tables, sample, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.32: real whale wallet buy feed for the Research Center.
// GET /api/whales — summary for ALL tracked wallets (last buy, 24h count).
//   Tiered: user's 10 priority wallets refresh every 120s; remaining 156
//   rotate 20 per cycle (full rotation ≈ 16 min).
// GET /api/whales/:address/buys — buy history detail for one wallet.
// POST /api/research/synthesize — accumulation signals: tokens bought by
//   2+ distinct tracked wallets in the last 24h. Read-only, never trades.
app.get('/api/whales', async (req, res) => {  try {
    const { getWhalesSummary } = await import('../lib/whales.js');
    const d = await getWhalesSummary();
    res.json({ ok: true, ...d });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.get('/api/whales/:address/buys', async (req, res) => {  try {
    const { getWalletBuys } = await import('../lib/whales.js');
    const addr = String(req.params.address || '').trim();
    if (!addr || addr.length < 32) return res.status(400).json({ ok: false, error: 'bad address' });
    const d = await getWalletBuys(addr);
    res.json({ ok: true, ...d });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// POST /api/research/synthesize — whale accumulation signals (read-only).
app.post('/api/research/synthesize', async (req, res) => {  try {
    const { synthesizeResearch } = await import('../lib/whales.js');
    const d = await synthesizeResearch();
    res.json({ ok: true, ...d });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.24: dry-run the real entry path — exercises every check without spending.
// Returns step-by-step diagnostic to verify real trading is wired correctly.
app.get('/api/realbook/dryrun', async (req, res) => {
  try {
    const { realDryRun } = await import('../lib/realbook.js');
    const result = await realDryRun();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.25: force-close REAL positions (admin — for zombie/rugged positions
// the sweeper can't sell on-chain, e.g. zero liquidity). This removes them
// from the book WITHOUT an on-chain sell — use /api/admin/sell-position
// first when a sell is possible. POST { mints: [...] } or { all: true }.
// v3.25: re-enable real mode after kill switch (POST {on: true}).
app.post('/api/admin/realmode', async (req, res) => {
  try {
    const { setRealMode } = await import('../lib/realbook.js');
    const on = !!(req.body && req.body.on);
    await setRealMode(on);
    res.json({ ok: true, on, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.post('/api/admin/close-positions', async (req, res) => {
  try {
    const { ensureRealBook, getRealBook, realClosePosition } = await import('../lib/realbook.js');
    await ensureRealBook();
    const R = getRealBook();
    if (!R) return res.status(500).json({ ok: false, error: 'no book' });
    const { mints, all } = req.body || {};
    // v3.26 CLOSE GUARANTEE: every close goes through realClosePosition,
    // which attempts the on-chain sell first. No silent book deletions.
    const { loadConfig } = await import('../lib/config.js');
    const cfg = loadConfig();
    const closed = [];
    for (const pos of [...(R.positions || [])]) {
      if (all || (mints && mints.includes(pos.mint))) {
        try {
          const trade = await realClosePosition(pos.mint, '🧹 admin close', cfg);
          closed.push({ symbol: pos.symbol, mint: pos.mint, sold: !!trade, reason: trade ? trade.exitReason : 'still open — will retry' });
        } catch (e) {
          closed.push({ symbol: pos.symbol, mint: pos.mint, sold: false, error: e.message });
        }
      }
    }
    res.json({ ok: true, closed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.24: restore a real position to the book (admin — for positions lost in book wipes).
// POST { position: { mint, symbol, name, solSize, sizeUsd, entryTs, entryTxSig, score, ... } }
app.post('/api/admin/restore-position', async (req, res) => {
  try {
    const { ensureRealBook, getRealBook } = await import('../lib/realbook.js');
    await ensureRealBook();
    const R = getRealBook();
    if (!R) return res.status(500).json({ ok: false, error: 'no book' });
    const p = req.body && req.body.position;
    if (!p || !p.mint) return res.status(400).json({ ok: false, error: 'position.mint required' });
    // Don't duplicate — but allow updating missing fields on existing
    const existing = (R.positions || []).find(x => x.mint === p.mint);
    if (existing) {
      // Backfill missing fields (entryMc, entryPrice, etc.)
      if (p.entryMc && !existing.entryMc) existing.entryMc = p.entryMc;
      if (p.entryPrice && !existing.entryPrice) existing.entryPrice = p.entryPrice;
      if (p.quotedOut && !existing.quotedOut) existing.quotedOut = p.quotedOut;
      // persist
      const { pool: pool2 } = await import('../db/pool.js');
      await pool2.query(
        `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
        [JSON.stringify(R)]
      ).catch(() => {});
      return res.json({ ok: true, restored: false, updated: true, reason: 'backfilled missing fields' });
    }
    R.positions.push({
      mint: p.mint, symbol: p.symbol || 'UNK', name: p.name || null,
      solSize: p.solSize || 0, sizeUsd: p.sizeUsd || 0,
      entryTs: p.entryTs || Date.now(), entryTxSig: p.entryTxSig || null,
      entryMc: p.entryMc || null, entryPrice: p.entryPrice || null,
      quotedOut: p.quotedOut || null,
      adaptiveTp: p.adaptiveTp ?? null, adaptiveSl: p.adaptiveSl ?? null,
      score: p.score ?? null, real: true, restored: true,
    });
    // v3.24: allow baseline correction (startSol/startUsd are sacred — only fix via admin)
    if (req.body.baselineSol && isFinite(Number(req.body.baselineSol))) {
      const spx = 150;
      R.startSol = Number(req.body.baselineSol);
      R.startUsd = R.startSol * spx;
    }
    // persist via the module's persist (import the internal)
    const { pool } = await import('../db/pool.js');
    await pool.query(
      `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(R)]
    ).catch(() => {});
    res.json({ ok: true, restored: true, symbol: p.symbol });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.24: manual sell — user hits SELL on a real position.
// POST { mint } → sells entire position via Jupiter, records close.
app.post('/api/admin/sell-position', async (req, res) => {
  try {
    const { realManualSell } = await import('../lib/realbook.js');
    const { mint } = req.body || {};
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    // cfg from tuning (slippage, priority fee)
    let cfg = {};
    try {
      const { kvGetJson } = await import('../lib/storage.js');
      cfg = (await kvGetJson('ab_tuning', {})) || {};
    } catch {}
    const trade = await realManualSell(mint, cfg);
    if (!trade) return res.json({ ok: false, error: 'position not found or sell failed — check logs' });
    res.json({ ok: true, symbol: trade.symbol, pnlUsd: trade.pnlUsd, txSig: trade.exitTxSig });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// v3.21: Learning Room — wallet style profiles.
import { analyzeStyle, synthesizeStrategy } from '../lib/walletAnalysis.js';
const styleProfiles = new Map(); // wallet -> { label, profile, ts }

app.post('/api/learn/wallet', async (req, res) => {
  try {
    const { wallet, label, trades } = req.body || {};
    if (!wallet) {
      return res.status(400).json({ ok: false, error: 'need wallet' });
    }
    let tradeData = trades;
    // v3.21: auto-pull from chain if no trades provided (1000 swaps for deep history)
    if (!tradeData || !Array.isArray(tradeData) || !tradeData.length) {
      try {
        const { buildTradeHistory } = await import('../lib/walletHistory.js');
        tradeData = await buildTradeHistory(wallet, 1000);
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'auto-pull failed: ' + (e.message || e) });
      }
    }
    const profile = analyzeStyle(tradeData);
    styleProfiles.set(wallet, {
      label: label || wallet.slice(0, 8),
      profile,
      tradeCount: tradeData.length,
      ts: Date.now(),
    });
    res.json({ ok: true, wallet, label: label || wallet.slice(0, 8), profile, trades: tradeData.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.get('/api/learn/profiles', async (req, res) => {
  const out = [];
  for (const [wallet, data] of styleProfiles) {
    out.push({ wallet, ...data });
  }
  res.json({ ts: Date.now(), profiles: out });
});

app.post('/api/learn/synthesize', async (req, res) => {
  try {
    const profiles = [...styleProfiles.values()].map(d => d.profile);
    if (!profiles.length) {
      return res.status(400).json({ ok: false, error: 'no profiles to synthesize' });
    }
    const strategy = synthesizeStrategy(profiles);
    res.json({ ok: true, ts: Date.now(), strategy, profileCount: profiles.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.post('/api/learn/apply', async (req, res) => {
  try {
    const profiles = [...styleProfiles.values()].map(d => d.profile);
    if (!profiles.length) {
      return res.status(400).json({ ok: false, error: 'no profiles to synthesize' });
    }
    const strategy = synthesizeStrategy(profiles);
    const out = await patchTuning({
      takeProfit: strategy.takeProfit,
      stopLoss: strategy.stopLoss,
      maxHoldHours: strategy.maxHoldHours,
    });
    res.json({ ok: true, ts: Date.now(), strategy, applied: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// The learning floor: ledgers, hit rates, correlations, exit rules.
app.get('/api/brain', async (req, res) => {
  let brain = null, exitRules = null;
  try { brain = getBrainStats(); } catch { /* noop */ }
  try {
    const r = getExitRules(loadConfig());
    exitRules = { ready: r.ready, n: r.n, runner: r.runner, deadCut: r.deadCut, buckets: r.buckets };
  } catch { /* noop */ }
  res.json({ ts: Date.now(), brain, exitRules, judge: getJudgeStats() });
});

// Recent pipeline events (for the activity feed).
app.get('/api/events', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
  res.json({ ts: Date.now(), events: recentEvents(limit) });
});

// ---------------------------------------------------------------- errors
app.use((err, req, res, _next) => {
  console.error('[api] error:', err.message);
  res.status(500).json({ ok: false, error: 'internal' });
});

// v3.37: live config verification — exposes critical trading params so we can
// verify what's ACTUALLY running, not just what was committed.
// NOTE: must be registered BEFORE the 404 catch-all below.
app.get('/api/live-config', async (req, res) => {
  try {
    const { cfg } = await import('../lib/config.js');
    res.json({
      ok: true,
      ts: Date.now(),
      sizes: { base: cfg.solSizeBase, mid: cfg.solSizeMid, top: cfg.solSizeTop, flat: 0.05 },
      fees: { priority: cfg.priorityFeeLamports, jitoTip: cfg.jitoTipLamports },
      sl: { min: 0.10, max: 0.40 },
      tp: { min: 1.0, max: 5.0 },
      killSwitch: cfg.killSwitchEquity || 11,
      maxPositions: cfg.maxPositions,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// ---------------------------------------------------------------- boot
startLoop()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[api] alphabot-backend listening on :${PORT} (db: ${hasDb ? 'postgres' : 'in-memory'})`);
    });
  })
  .catch((e) => {
    console.error('[api] failed to start loop:', e.message);
    process.exit(1);
  });

process.on('unhandledRejection', (e) => console.error('[api] unhandled rejection:', e && e.message));
