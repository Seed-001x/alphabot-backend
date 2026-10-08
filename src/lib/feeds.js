// ALPHABOT backend — FEED ENGINE (ported from the frontend desk).
// NEW / TRENDING / MOVERS. MOVERS snapshots persist via the KV store
// (durable when a DB is present). No new API keys, fail-open everywhere.

import { storage } from './storage.js';

const LS_KEY = 'alphabot_movers_v1';
const MAX_MINTS = 300;
const WINDOW_MS = 24 * 3600 * 1000;
const MIN_WINDOW_H = 0.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadStore() {
  try { return JSON.parse(storage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
function saveStore(s) {
  try { storage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* full/blocked */ }
}

export function recordSnapshots(cands) {
  try {
    const s = loadStore();
    const now = Date.now();
    for (const t of cands) {
      if (!t || !t.address || !(t.mc > 0)) continue;
      const e = s[t.address] || {};
      e.prev = e.last || null;
      e.last = { mc: t.mc, vol: t.vol24h || 0, ts: now };
      if (!e.first) e.first = e.last;
      s[t.address] = e;
    }
    for (const k of Object.keys(s)) {
      if (now - ((s[k].last && s[k].last.ts) || 0) > WINDOW_MS) delete s[k];
    }
    const keys = Object.keys(s);
    if (keys.length > MAX_MINTS) {
      keys.sort((a, b) => ((s[a].last && s[a].last.ts) || 0) - ((s[b].last && s[b].last.ts) || 0));
      for (const k of keys.slice(0, keys.length - MAX_MINTS)) delete s[k];
    }
    saveStore(s);
  } catch { /* fail-open */ }
}

// v3.26: raw snapshot accessor for the antiscam mover-quality bonus.
export function getSnapshot(mint) {
  try {
    const s = loadStore();
    return s[mint] || null;
  } catch { return null; }
}

export function computeMovers(limit = 40) {  try {
    const s = loadStore();
    const now = Date.now();
    const out = [];
    for (const [mint, e] of Object.entries(s)) {
      if (!e.first || !e.last || !(e.first.mc > 0)) continue;
      const ageH = (now - e.first.ts) / 3600000;
      if (ageH < MIN_WINDOW_H) continue;
      const moverPct = ((e.last.mc - e.first.mc) / e.first.mc) * 100;
      const volAccel = e.prev && e.prev.vol > 0 && e.last.vol != null
        ? e.last.vol / e.prev.vol : null;
      out.push({ mint, moverPct, volAccel, firstTs: e.first.ts, lastTs: e.last.ts });
    }
    out.sort((a, b) =>
      (b.moverPct - a.moverPct) ||
      ((b.volAccel || 0) - (a.volAccel || 0)));
    return out.slice(0, limit);
  } catch { return []; }
}

// buildFeeds({ fresh, pumpLatest, pumpTop, profiles, boosts, enriched, ppMints })
// The backend adds pumpLatest/pumpTop (direct pump.fun API) as NEW/TRENDING.
export function buildFeeds({ fresh, pumpLatest, pumpTop, profiles, boosts, enriched, ppMints }) {
  const tags = new Map();
  const tag = (mint, f) => {
    if (!mint) return;
    if (!tags.has(mint)) tags.set(mint, []);
    const arr = tags.get(mint);
    if (!arr.includes(f)) arr.push(f);
  };
  const newSet = new Set(
    [...(fresh || []).map(f => f.address),
     ...((pumpLatest || []).map(f => f.address)),
     ...((ppMints || []))].filter(Boolean)
  );
  const trendSet = new Set();
  for (const s of [...(pumpTop || []), ...(profiles || []), ...(boosts || [])]) {
    if (s && s.address) trendSet.add(s.address);
  }

  const cands = [...(enriched || new Map()).values()];
  recordSnapshots(cands);
  const movers = computeMovers();
  const moverMap = new Map(movers.map(m => [m.mint, m]));

  for (const m of newSet) tag(m, 'new');
  for (const m of trendSet) tag(m, 'trending');
  for (const m of moverMap.keys()) tag(m, 'movers');

  const row = (t) => ({
    mint: t.address, symbol: t.symbol, name: t.name,
    mc: t.mc, vol24h: t.vol24h,
    txns: (t.buys24h || 0) + (t.sells24h || 0),
    createdAt: t.createdAt, url: t.url || null,
    tags: tags.get(t.address) || [],
  });

  const newRows = [];
  for (const m of newSet) {
    const t = enriched.get(m);
    if (t) newRows.push(row(t));
  }
  newRows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const trendRows = [];
  for (const m of trendSet) {
    const t = enriched.get(m);
    if (!t) continue;
    const r = row(t);
    r.trendScore = (t.vol24h || 0) * ((t.buys24h || 0) + (t.sells24h || 0));
    trendRows.push(r);
  }
  trendRows.sort((a, b) => (b.trendScore || 0) - (a.trendScore || 0));

  const moverRows = [];
  for (const m of movers) {
    const t = enriched.get(m.mint);
    if (!t) continue;
    const r = row(t);
    r.moverPct = m.moverPct;
    r.volAccel = m.volAccel;
    moverRows.push(r);
  }

  return {
    tags,
    movers: moverMap,
    rows: {
      new: newRows.slice(0, 25),
      trending: trendRows.slice(0, 25),
      movers: moverRows.slice(0, 25),
    },
  };
}

export function momentumScore(t) {
  if (t.moverPct != null && isFinite(t.moverPct)) {
    return clamp(50 + t.moverPct * 0.25, 0, 100);
  }
  if (t.feeds && t.feeds.includes('trending')) return 55;
  return null;
}

// Ignition detector — the sniper's entry. Sudden volume expansion on a low
// market cap = the moment before the pump. Uses one-cycle volume jump from
// the snapshot store (fast), not the slow 24h aggregates.
export function ignitionSignal(mint, t) {
  try {
    const s = loadStore();
    const e = s[mint];
    if (!e || !e.prev || !e.last) return null;
    if (!(e.prev.vol > 0)) return null;
    const spike = (e.last.vol || 0) / e.prev.vol;
    const gradRun = t && t.curvePct != null && t.curvePct >= 75 && spike >= 1.2;
    const ignition = spike >= 1.5 && t && t.mc < 200000;
    if (!ignition && !gradRun) return null;
    return { ignition, gradRun, spike };
  } catch { return null; }
}
// Accumulation detector — the user's edge: buy the slow volume crawl,
// not the boom. From the snapshot store (first/prev/last per mint):
// vol climbing steadily (×1.5+, rising across snapshots) while market cap
// hasn't exploded yet (< +50%) = accumulation. MC already doubled in-window
// = chased. Fail-open: returns null when history is thin.
export function accumulationSignal(mint) {
  try {
    const s = loadStore();
    const e = s[mint];
    if (!e || !e.first || !e.prev || !e.last) return null;
    if (!(e.first.vol > 0) || !(e.first.mc > 0)) return null;
    const volGrowth = e.last.vol / e.first.vol;
    const rising = e.prev.vol > e.first.vol && e.last.vol >= e.prev.vol;
    const mcapChange = (e.last.mc - e.first.mc) / e.first.mc;
    const acc = volGrowth >= 1.5 && rising && mcapChange < 0.5;
    const chase = mcapChange >= 1.0;
    if (!acc && !chase) return null;
    return { acc, chase, volGrowth, mcapChange };
  } catch { return null; }
}
