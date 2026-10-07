// ALPHABOT backend — LEARNING FLOOR ledgers, DURABLE edition.
// Same API as the frontend desk, but kills/trades/creators/weights persist
// in Postgres (ab_kill_ledger, ab_trade_journal, ab_creator_ledger,
// ab_learned_weights) with an in-memory hot cache. Without DATABASE_URL,
// everything degrades to in-memory (process lifetime).
// HARD RULES: adaptive weights NEVER override kill-chain hard kills;
// cold start (below minimums) → defaults; fail-open everywhere.

import { pool, hasDb } from '../db/pool.js';
import { fetchRugReport } from './pumpfun.js';
import { fetchTokens } from './dexscreener.js';

const CAP = 500;
export const MIN_KILLS = 30;
export const MIN_TRADES = 10;
const MAX_SHIFT_DAY = 0.15;
const W_FLOOR = 5, W_CEIL = 40;
const CONFIRM_BATCH = 3;
const KILL_DEDUP_MS = 30 * 60 * 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '?'));

// ------------------------------------------------------------ in-memory hot cache
let kills = [];   // [{ id?, mint, symbol, pass, fam, reason, creator, mc, ts, status, checkedTs }]
let journal = []; // [{ id?, mint, symbol, entryTs, entryMc, score, breakdown, feeds, researchMod, researchLine, eliteHit, exitTs, exitMc, pnlPct, exitReason, holdMs, buyPressure, creator }]
let creators = {}; // creator -> { launches, rugged, moon2x, lastSeen }
let learnState = { weights: null, lastAdaptTs: 0, adaptLog: [] };
let hydrated = false;

const q = (text, params) => pool.query(text, params).catch(() => null);

export async function initLearning() {
  if (!hasDb) return;
  try {
    const [k, j, c, w] = await Promise.all([
      q('SELECT * FROM ab_kill_ledger ORDER BY id DESC LIMIT $1', [CAP]),
      q('SELECT * FROM ab_trade_journal ORDER BY id DESC LIMIT $1', [CAP]),
      q('SELECT * FROM ab_creator_ledger'),
      q('SELECT * FROM ab_learned_weights WHERE id = 1'),
    ]);
    if (k && k.rows) {
      kills = k.rows.reverse().map(r => ({
        id: r.id, mint: r.mint, symbol: r.symbol, pass: r.pass, fam: r.fam,
        reason: r.reason, creator: r.creator, mc: r.mc != null ? Number(r.mc) : null,
        ts: new Date(r.ts).getTime(), status: r.status,
        checkedTs: r.checked_ts ? new Date(r.checked_ts).getTime() : 0,
      }));
    }
    if (j && j.rows) {
      journal = j.rows.reverse().map(r => ({
        id: r.id, mint: r.mint, symbol: r.symbol,
        entryTs: new Date(r.entry_ts).getTime(),
        entryMc: r.entry_mc != null ? Number(r.entry_mc) : null,
        score: r.score, breakdown: r.breakdown, feeds: r.feeds,
        researchMod: r.research_mod, researchLine: r.research_line,
        eliteHit: r.elite_hit,
        exitTs: r.exit_ts ? new Date(r.exit_ts).getTime() : null,
        exitMc: r.exit_mc != null ? Number(r.exit_mc) : null,
        pnlPct: r.pnl_pct != null ? Number(r.pnl_pct) : null,
        exitReason: r.exit_reason, holdMs: r.hold_ms != null ? Number(r.hold_ms) : null,
        buyPressure: r.buy_pressure != null ? Number(r.buy_pressure) : null,
        creator: r.creator,
      }));
    }
    if (c && c.rows) {
      for (const r of c.rows) {
        creators[r.creator] = {
          launches: r.launches, rugged: r.rugged, moon2x: r.moon2x,
          lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0,
        };
      }
    }
    if (w && w.rows && w.rows[0]) {
      learnState = {
        weights: w.rows[0].weights,
        lastAdaptTs: w.rows[0].last_adapt_ts ? new Date(w.rows[0].last_adapt_ts).getTime() : 0,
        adaptLog: w.rows[0].adapt_log || [],
      };
    }
    hydrated = true;
    console.log(`[learning] hydrated: ${kills.length} kills, ${journal.length} journal rows, ${Object.keys(creators).length} creators`);
  } catch (e) {
    console.error('[learning] hydration failed:', e.message);
  }
}

// ------------------------------------------------------------ kill ledger
export function reasonFamily(reason) {
  const r = String(reason || '');
  if (/^age /.test(r)) return 'age';
  if (/authority/i.test(r)) return 'authority';
  if (/^liq /.test(r)) return 'liq';
  if (/^vol24h /.test(r)) return 'vol';
  if (/^MC /.test(r)) return 'mc-band';
  if (/^buys24h/.test(r)) return 'buys';
  if (/sells24h/.test(r)) return 'sells';
  if (/trade counts unknown/.test(r)) return 'trade-unknown';
  if (/RUGGED/.test(r)) return 'rugged';
  if (/^dev holds/.test(r)) return 'dev%';
  if (/^top holder/.test(r)) return 'top%';
  if (/^top-10/.test(r)) return 'top10%';
  if (/^holders /.test(r)) return 'holders';
  if (/dossier unavailable/.test(r)) return 'dossier-unknown';
  return 'other';
}

export function logKill(t, killPass, killReason) {
  try {
    const now = Date.now();
    if (kills.some(e => e.mint === t.address && now - e.ts < KILL_DEDUP_MS)) return;
    const e = {
      mint: t.address, symbol: t.symbol || '???', pass: killPass,
      fam: reasonFamily(killReason), reason: String(killReason || '').slice(0, 120),
      creator: t.creator || null, mc: t.mc || null, ts: now,
      status: 'open', checkedTs: 0,
    };
    kills.push(e);
    while (kills.length > CAP) kills.shift();
    if (hasDb && hydrated) {
      q(
        'INSERT INTO ab_kill_ledger (mint, symbol, pass, fam, reason, creator, mc, ts, status) VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),\'open\') RETURNING id',
        [e.mint, e.symbol, e.pass, e.fam, e.reason, e.creator, e.mc, e.ts]
      ).then(r => { if (r && r.rows[0]) e.id = r.rows[0].id; });
      // prune table beyond 2x cap
      q('DELETE FROM ab_kill_ledger WHERE id NOT IN (SELECT id FROM ab_kill_ledger ORDER BY id DESC LIMIT 1000)');
    }
  } catch { /* fail-open */ }
}

export async function confirmKills() {
  try {
    const now = Date.now();
    const open = kills
      .filter(e => e.status === 'open' && now - (e.checkedTs || 0) > 6 * 3600e3)
      .sort((a, b) => a.ts - b.ts).slice(0, CONFIRM_BATCH);
    if (!open.length) return 0;
    let pairs = {};
    try { pairs = await fetchTokens(open.map(e => e.mint)); } catch { /* optional */ }
    for (const e of open) {
      e.checkedTs = now;
      let verdict = null;
      try {
        const d = await fetchRugReport(e.mint);
        if (d && d.rugged) verdict = 'confirmed';
      } catch { /* optional */ }
      if (!verdict) {
        const pair = pairs[e.mint];
        const mc = pair ? (+(pair.marketCap || 0) || +(pair.fdv || 0) || null) : null;
        const ageH = (now - e.ts) / 3600e3;
        if (mc == null) verdict = 'confirmed';
        else if (e.mc > 0 && mc < e.mc * 0.5) verdict = 'confirmed';
        else if (e.mc > 0 && mc > e.mc * 3) verdict = 'escaped';
        else if (ageH > 48 && mc < e.mc * 1.5) verdict = 'confirmed';
      }
      if (verdict) {
        e.status = verdict;
        if (verdict === 'confirmed') noteCreatorOutcome(e.creator, 'rugged');
        if (hasDb && hydrated && e.id) {
          q('UPDATE ab_kill_ledger SET status = $1, checked_ts = to_timestamp($2/1000.0) WHERE id = $3', [verdict, now, e.id]);
        }
      } else if (hasDb && hydrated && e.id) {
        q('UPDATE ab_kill_ledger SET checked_ts = to_timestamp($1/1000.0) WHERE id = $2', [now, e.id]);
      }
    }
    return open.length;
  } catch { return 0; }
}

export function killHitRates() {
  try {
    const by = {};
    for (const e of kills) {
      if (e.status !== 'confirmed' && e.status !== 'escaped') continue;
      const b = by[e.fam] || (by[e.fam] = { fam: e.fam, confirmed: 0, n: 0 });
      b.n++;
      if (e.status === 'confirmed') b.confirmed++;
    }
    return Object.values(by)
      .map(b => ({ ...b, rate: b.n ? b.confirmed / b.n : 0 }))
      .sort((a, b) => b.n - a.n);
  } catch { return []; }
}

// ---------------------------------------------------------- trade journal
export function logTradeEntry(snap) {
  try {
    const e = { ...snap, entryTs: Date.now(), exitTs: null, pnlPct: null };
    journal.push(e);
    while (journal.length > CAP) journal.shift();
    if (hasDb && hydrated) {
      q(
        `INSERT INTO ab_trade_journal (mint, symbol, entry_ts, entry_mc, score, breakdown, feeds, research_mod, research_line, elite_hit, buy_pressure, creator, m5_change)
         VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [e.mint, e.symbol || null, e.entryTs, e.entryMc ?? null, e.score ?? null,
         JSON.stringify(e.breakdown || null), JSON.stringify(e.feeds || null),
         e.researchMod ?? null, e.researchLine || null, !!e.eliteHit,
         e.buyPressure ?? null, e.creator || null, e.m5Change ?? null]
      ).then(r => { if (r && r.rows[0]) e.id = r.rows[0].id; });
      q('DELETE FROM ab_trade_journal WHERE id NOT IN (SELECT id FROM ab_trade_journal ORDER BY id DESC LIMIT 1000)');
    }
  } catch { /* fail-open */ }
}

export function logTradeExit(trade) {
  try {
    const pnlPct = trade.multiple != null ? (trade.multiple - 1) * 100 : null;
    let best = null;
    for (const e of journal) {
      if (e.exitTs != null || e.mint !== trade.mint) continue;
      if (trade.entryTs && e.entryTs && Math.abs(e.entryTs - trade.entryTs) > 3600e3) continue;
      if (!best || e.entryTs > best.entryTs) best = e;
    }
    if (best) {
      best.exitTs = Date.now();
      best.exitMc = trade.exitMc ?? null;
      best.pnlPct = pnlPct;
      best.exitReason = trade.exitReason || null;
      best.holdMs = trade.holdMs ?? null;
      if (best.creator && pnlPct != null && pnlPct >= 100) noteCreatorOutcome(best.creator, 'moon2x');
      if (hasDb && hydrated && best.id) {
        q(
          'UPDATE ab_trade_journal SET exit_ts = to_timestamp($1/1000.0), exit_mc = $2, pnl_pct = $3, exit_reason = $4, hold_ms = $5 WHERE id = $6',
          [best.exitTs, best.exitMc, best.pnlPct, best.exitReason, best.holdMs, best.id]
        );
      }
    }
  } catch { /* fail-open */ }
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (!(dx > 0 && dy > 0)) return null;
  return num / Math.sqrt(dx * dy);
}

export function componentCorrelations() {
  try {
    const closed = journal.filter(t => t.exitTs != null && t.pnlPct != null && t.breakdown);
    const comps = ['liquidity', 'holders', 'buyPressure', 'curve', 'age', 'momentum'];
    const out = comps.map(c => {
      const pairs = closed
        .filter(t => t.breakdown[c] != null && isFinite(t.breakdown[c]))
        .map(t => [t.breakdown[c], t.pnlPct]);
      const r = pairs.length >= 4
        ? pearson(pairs.map(p => p[0]), pairs.map(p => p[1])) : null;
      return { comp: c, r, n: pairs.length };
    });
    // m5Change is a journal-level feature (not a score component): high m5 at
    // entry = post-pump chase (snipe-and-dump pattern). Negative correlation
    // here teaches the bot to fade those entries over time.
    const m5pairs = journal
      .filter(t => t.exitTs != null && t.pnlPct != null && t.m5Change != null && isFinite(t.m5Change))
      .map(t => [t.m5Change, t.pnlPct]);
    out.push({
      comp: 'm5Change',
      r: m5pairs.length >= 4 ? pearson(m5pairs.map(p => p[0]), m5pairs.map(p => p[1])) : null,
      n: m5pairs.length,
    });
    return out;
  } catch { return []; }
}

// Learned post-pump penalty: if journal shows high-m5 entries lose money,
// shave score proportionally. Soft and gradual — no hard block. Pre-pump
// snipes (low m5 at entry, like Taylor) are unaffected.
export function m5EntryPenalty(m5) {
  try {
    if (m5 == null || !isFinite(m5) || m5 <= 50) return 0;
    const corr = componentCorrelations().find(c => c.comp === 'm5Change');
    if (!corr || corr.r == null || corr.n < 10 || corr.r >= -0.15) return 0;
    // Negative correlation confirmed: scale penalty 0..12 pts by m5 magnitude
    const strength = Math.min(1, Math.abs(corr.r) * 2);
    const mag = Math.min(1, (m5 - 50) / 450);
    return Math.round(12 * strength * mag);
  } catch { return 0; }
}

export function journalStats() {
  try {
    const closed = journal.filter(t => t.exitTs != null && t.pnlPct != null);
    const wins = closed.filter(t => t.pnlPct > 0);
    const avg = closed.length ? closed.reduce((a, t) => a + t.pnlPct, 0) / closed.length : null;
    const best = closed.length ? closed.reduce((a, t) => (t.pnlPct > (a.pnlPct ?? -Infinity) ? t : a), {}) : null;
    return {
      entries: journal.length, closed: closed.length,
      wins: wins.length,
      winRate: closed.length ? wins.length / closed.length : null,
      avgPnl: avg, best,
    };
  } catch { return { entries: 0, closed: 0, wins: 0, winRate: null, avgPnl: null, best: null }; }
}

// ------------------------------------------------------- creator outcomes
export function noteCreatorOutcome(creator, kind) {
  if (!creator) return;
  try {
    const e = creators[creator] || { launches: 0, rugged: 0, moon2x: 0, lastSeen: 0 };
    if (kind === 'rugged') e.rugged = (e.rugged || 0) + 1;
    else if (kind === 'moon2x') e.moon2x = (e.moon2x || 0) + 1;
    e.lastSeen = Date.now();
    creators[creator] = e;
    if (hasDb && hydrated) {
      q(
        `INSERT INTO ab_creator_ledger (creator, launches, rugged, moon2x, last_seen, updated_at)
         VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),NOW())
         ON CONFLICT (creator) DO UPDATE SET
           launches = GREATEST(ab_creator_ledger.launches, EXCLUDED.launches),
           rugged = ab_creator_ledger.rugged + EXCLUDED.rugged,
           moon2x = ab_creator_ledger.moon2x + EXCLUDED.moon2x,
           last_seen = EXCLUDED.last_seen, updated_at = NOW()`,
        [creator, e.launches || 0, kind === 'rugged' ? 1 : 0, kind === 'moon2x' ? 1 : 0, e.lastSeen]
      );
    }
  } catch { /* fail-open */ }
}

export function noteCreatorLaunchCount(creator, launches) {
  if (!creator) return;
  try {
    const e = creators[creator] || { launches: 0, rugged: 0, moon2x: 0, lastSeen: 0 };
    e.launches = Math.max(e.launches || 0, launches);
    e.lastSeen = Date.now();
    creators[creator] = e;
    if (hasDb && hydrated) {
      q(
        `INSERT INTO ab_creator_ledger (creator, launches, last_seen, updated_at)
         VALUES ($1,$2,to_timestamp($3/1000.0),NOW())
         ON CONFLICT (creator) DO UPDATE SET
           launches = GREATEST(ab_creator_ledger.launches, EXCLUDED.launches),
           last_seen = EXCLUDED.last_seen, updated_at = NOW()`,
        [creator, e.launches, e.lastSeen]
      );
    }
  } catch { /* fail-open */ }
}

export function creatorOutcome(creator) {
  try {
    const e = creators[creator];
    if (!e) return null;
    return { launches: e.launches || 0, rugged: e.rugged || 0, moon2x: e.moon2x || 0 };
  } catch { return null; }
}

// ------------------------------------------------------- adaptive scoring
export function getAdaptiveWeights(defaults) {
  const fresh = { weights: { ...defaults }, adapted: false, collecting: true, stats: { kills: 0, trades: 0 }, log: [] };
  try {
    const weights = { ...defaults, ...(learnState.weights || {}) };
    const kCount = kills.filter(e => e.status === 'confirmed').length;
    const tCount = journal.filter(t => t.exitTs != null).length;
    const out = { weights, adapted: false, collecting: true, stats: { kills: kCount, trades: tCount }, log: learnState.adaptLog || [] };
    out.adapted = Object.keys(defaults).some(k => Math.abs((weights[k] ?? defaults[k]) - defaults[k]) > 0.01);
    if (kCount < MIN_KILLS || tCount < MIN_TRADES) return out;
    out.collecting = false;
    if (Date.now() - (learnState.lastAdaptTs || 0) < 24 * 3600e3) return out;
    const corrs = componentCorrelations().filter(c => c.r != null && c.n >= MIN_TRADES);
    if (!corrs.length) return out;
    const before = { ...weights };
    let changed = false;
    for (const { comp, r } of corrs) {
      if (!(comp in defaults)) continue;
      const target = clamp(defaults[comp] * (1 + clamp(r, -0.5, 0.5) * 0.6), W_FLOOR, W_CEIL);
      const cur = weights[comp];
      const maxDelta = cur * MAX_SHIFT_DAY;
      const next = Math.round(clamp(target, cur - maxDelta, cur + maxDelta) * 10) / 10;
      if (Math.abs(next - cur) > 0.01) { weights[comp] = next; changed = true; }
    }
    if (changed) {
      out.weights = weights;
      out.adapted = true;
      out.log = [{
        ts: Date.now(), before, after: { ...weights },
        nTrades: tCount, nKills: kCount,
        note: 'weights nudged toward journal-proven components (±15%/day cap)',
      }, ...(learnState.adaptLog || [])].slice(0, 50);
      learnState = { weights: { ...weights }, lastAdaptTs: Date.now(), adaptLog: out.log };
      if (hasDb && hydrated) {
        q(
          `INSERT INTO ab_learned_weights (id, weights, last_adapt_ts, adapt_log, updated_at)
           VALUES (1, $1::jsonb, to_timestamp($2/1000.0), $3::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET weights = EXCLUDED.weights,
             last_adapt_ts = EXCLUDED.last_adapt_ts, adapt_log = EXCLUDED.adapt_log,
             updated_at = NOW()`,
          [JSON.stringify(weights), Date.now(), JSON.stringify(out.log)]
        );
      }
    }
    return out;
  } catch {
    return fresh;
  }
}

// ------------------------------------------------------- judge context
export function getJudgeContext(t) {
  try {
    const lines = [];
    if (t.creator) {
      const c = creatorOutcome(t.creator);
      if (c && (c.launches || c.rugged || c.moon2x)) {
        lines.push(`creator ${short(t.creator)}: ${c.launches} launches, ${c.rugged} rugged, ${c.moon2x} 2x+ (this desk's observed history)`);
      }
    }
    for (const r of killHitRates().filter(r => r.n >= 5).slice(0, 3)) {
      lines.push(`kill reason '${r.fam}' confirmed ${(r.rate * 100).toFixed(0)}% (n=${r.n})`);
    }
    for (const c of componentCorrelations().filter(c => c.r != null && c.n >= MIN_TRADES)) {
      lines.push(`score component '${c.comp}' correlates ${c.r >= 0 ? '+' : ''}${c.r.toFixed(2)} with realized P&L (n=${c.n})`);
    }
    if (!lines.length) return '';
    return 'FLOOR LEDGERS (this desk\'s own observed history — treat as weak priors, judge the token on its merits):\n'
      + lines.map(l => '- ' + l).join('\n');
  } catch { return ''; }
}

// ------------------------------------------------------- brain + reset
export function readJournal() {
  try { return journal.slice(); } catch { return []; }
}

export function getBrainStats() {
  try {
    const js = journalStats();
    const rates = killHitRates();
    const corrs = componentCorrelations();
    const confirmedKills = kills.filter(e => e.status === 'confirmed').length;
    const totalKills = kills.length;
    return {
      ...js, confirmedKills, totalKills, hitRates: rates, correlations: corrs,
      collecting: js.closed < MIN_TRADES || confirmedKills < MIN_KILLS,
      minKills: MIN_KILLS, minTrades: MIN_TRADES,
    };
  } catch {
    return { entries: 0, closed: 0, wins: 0, winRate: null, avgPnl: null, best: null, confirmedKills: 0, totalKills: 0, hitRates: [], correlations: [], collecting: true, minKills: MIN_KILLS, minTrades: MIN_TRADES };
  }
}

export async function resetLearning() {
  try {
    kills = [];
    journal = [];
    learnState = { weights: null, lastAdaptTs: 0, adaptLog: [] };
    for (const k of Object.keys(creators)) { delete creators[k].rugged; delete creators[k].moon2x; }
    if (hasDb) {
      await pool.query('TRUNCATE ab_kill_ledger, ab_trade_journal, ab_learned_weights');
      await pool.query('UPDATE ab_creator_ledger SET rugged = 0, moon2x = 0');
    }
    return true;
  } catch { return false; }
}
