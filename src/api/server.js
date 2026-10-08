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
app.post('/api/admin/close-positions', async (req, res) => {
  try {
    const { ensureRealBook, getRealBook } = await import('../lib/realbook.js');
    await ensureRealBook();
    const R = getRealBook();
    if (!R) return res.status(500).json({ ok: false, error: 'no book' });
    const { mints, all } = req.body || {};
    const now = Date.now();
    const closed = [];
    const keep = [];
    for (const pos of (R.positions || [])) {
      if (all || (mints && mints.includes(pos.mint))) {
        const trade = {
          mint: pos.mint, symbol: pos.symbol, name: pos.name,
          solSize: pos.solSize, sizeUsd: pos.sizeUsd,
          proceedsUsd: 0, pnlUsd: -(pos.sizeUsd || 0),
          multiple: 0,
          entryTxSig: pos.entryTxSig, exitTxSig: null,
          entryTs: pos.entryTs, exitTs: now,
          holdMs: now - pos.entryTs,
          exitReason: '🧹 admin force-close (zombie, no on-chain sell)',
          score: pos.score, real: true,
        };
        R.closed = [trade, ...(R.closed || [])].slice(0, 500);
        R.cooldowns = { ...(R.cooldowns || {}), [pos.mint]: now };
        closed.push({ symbol: pos.symbol, mint: pos.mint });
      } else {
        keep.push(pos);
      }
    }
    R.positions = keep;
    const { pool } = await import('../db/pool.js');
    await pool.query(
      `INSERT INTO ab_desk_state (id, state, updated_at) VALUES (2, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(R)]
    ).catch(() => {});
    res.json({ ok: true, closed: closed.length, symbols: closed.map(c => c.symbol) });
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
