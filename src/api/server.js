// ALPHABOT backend — Express API entrypoint.
// Read-only state API (CORS open for the GitHub Pages frontend).
// Paper trading only. No wallet keys, no signing, no Telegram.

import express from 'express';
import { pool, hasDb } from '../db/pool.js';
import { startLoop, getStateSnapshot, getClosedTrades, cycleStats } from '../pipeline/loop.js';
import { getBrainStats, resetLearning } from '../lib/learning.js';
import { getExitRules } from '../lib/exits.js';
import { loadConfig } from '../lib/config.js';
import { getJudgeStats } from '../lib/aiJudge.js';
import { recentEvents } from '../lib/events.js';

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
    paper: true,
  });
});

// ---------------------------------------------------------------- state
// Full snapshot for the frontend "backend mode": portfolio, positions,
// stats, feeds, brain, events, queues, cycle counters.
app.get('/api/state', async (req, res) => {
  res.json(getStateSnapshot());
});

// Closed paper trades, newest first.
app.get('/api/trades', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ts: Date.now(), trades: getClosedTrades(limit) });
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
