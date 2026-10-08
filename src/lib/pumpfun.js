// pump.fun discovery + RugCheck enrichment, server-side edition.
// RugCheck: new_tokens firehose + holder dossiers (as in the frontend desk).
// pump.fun frontend-api-v3: NO CORS server-side, so the backend calls it
// directly — exact creator, exact created_timestamp, real socials
// (twitter/website), and usd market cap, straight from the source.
//   GET /coins?sort=created_timestamp&order=DESC  → NEW feed
//   GET /coins?sort=market_cap&order=DESC         → TRENDING feed
// Verified live from a server 2026-10-06.

import { storage } from './storage.js';

const RC = 'https://api.rugcheck.xyz/v1';
const PF = 'https://frontend-api-v3.pump.fun';
export const PUMP_SUFFIX = 'pump';
export const PUMP_GRAD_MC = 69000;

const reportCache = new Map(); // mint -> { report, ts }
const REPORT_TTL = 120000;

// Per-mint socials cache from the pump.fun API (twitter/website/creator).
// Research consults this first — free, exact, no scraping.
const socialsCache = new Map(); // mint -> { twitter, website, telegram, creator, createdAt, name, symbol, image }
export function pumpSocials(mint) {
  return socialsCache.get(mint) || null;
}

function noteSocials(c) {
  if (!c || !c.mint) return;
  socialsCache.set(c.mint, {
    twitter: c.twitter || null,
    website: c.website || null,
    telegram: c.telegram || null,
    creator: c.creator || null,
    createdAt: c.created_timestamp || null,
    name: c.name || null,
    symbol: c.symbol || null,
    image: c.image_uri || null,
    usdMc: c.usd_market_cap ?? c.market_cap_usd ?? null,
    complete: c.complete === true,
  });
  if (socialsCache.size > 2000) {
    const k = socialsCache.keys().next().value;
    socialsCache.delete(k);
  }
}

async function pfCoins({ sort, order = 'DESC', limit = 40 }) {
  try {
    const u = `${PF}/coins?offset=0&limit=${limit}&sort=${sort}&order=${order}&includeNsfw=false`;
    const r = await fetch(u, { headers: { 'user-agent': 'alphabot-backend/1.0' } });
    if (!r.ok) return [];
    const arr = await r.json();
    const out = [];
    for (const c of arr || []) {
      if (!c || !c.mint || c.is_banned) continue;
      noteSocials(c);
      out.push({
        address: c.mint,
        symbol: c.symbol || '???',
        name: c.name || 'Unknown',
        creator: c.creator || null,
        createdAt: c.created_timestamp || null,
        usdMc: c.usd_market_cap ?? c.market_cap_usd ?? null,
        graduated: c.complete === true,
        source: 'pump-api',
        twitter: c.twitter || null,
        website: c.website || null,
      });
    }
    return out;
  } catch { return []; }
}

// NEW feed: freshest pump.fun launches, direct from the source.
export function fetchPumpLatest(limit = 40) {
  return pfCoins({ sort: 'created_timestamp', order: 'DESC', limit });
}

// TRENDING feed: top pump.fun coins by market cap, direct from the source.
export function fetchPumpTop(limit = 40) {
  return pfCoins({ sort: 'market_cap', order: 'DESC', limit });
}

// MOVERS feed: pump.fun coins sorted by momentum (price change).
// This catches mid-cap runners like the ones on pump.fun's Movers tab.
export function fetchPumpMovers(limit = 60) {
  return pfCoins({ sort: 'price_change_24h', order: 'DESC', limit });
}

// RugCheck firehose (as in the frontend desk).
export async function fetchFreshPumpCoins(limit = 40) {
  try {
    const r = await fetch(`${RC}/stats/new_tokens`);
    if (!r.ok) return [];
    const arr = await r.json();
    const out = [];
    for (const t of arr || []) {
      const mint = t.mint || '';
      if (!mint.endsWith(PUMP_SUFFIX)) continue;
      out.push({
        address: mint,
        symbol: t.symbol || '???',
        creator: t.creator || null,
        mintAuthOpen: t.mintAuthority ? true : t.mintAuthority === '' ? false : null,
        freezeAuthOpen: t.freezeAuthority ? true : t.freezeAuthority === '' ? false : null,
        createdAt: t.createAt ? Date.parse(t.createAt) : null,
        source: 'pump-fresh',
      });
      if (out.length >= limit) break;
    }
    rememberFresh(out);
    return [...recallFresh(), ...out.filter(o => !recallFresh().some(rf => rf.address === o.address))];
  } catch { return recallFresh(); }
}

const FRESH_KEY = 'alphabot_pumpfresh_v1';
const FRESH_TTL = 90 * 60 * 1000;
function recallFresh() {
  try {
    const raw = storage.getItem(FRESH_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    const now = Date.now();
    return (arr || []).filter(f => f.address && now - (f.seenAt || 0) < FRESH_TTL);
  } catch { return []; }
}
function rememberFresh(coins) {
  try {
    const now = Date.now();
    const seen = new Map(recallFresh().map(f => [f.address, f]));
    for (const c of coins) if (!seen.has(c.address)) seen.set(c.address, { ...c, seenAt: now });
    const pruned = [...seen.values()].filter(f => now - (f.seenAt || 0) < FRESH_TTL).slice(-120);
    storage.setItem(FRESH_KEY, JSON.stringify(pruned));
  } catch { /* storage is a nicety */ }
}

export async function fetchRugReport(mint) {
  const now = Date.now();
  const c = reportCache.get(mint);
  if (c && now - c.ts < REPORT_TTL && c.report) return c.report;
  try {
    const r = await fetch(`${RC}/tokens/${mint}/report`);
    if (!r.ok) return null;
    const d = await r.json();
    const holders = d.topHolders || [];
    const topPct = holders.length ? holders[0].pct : null;
    const top10Pct = holders.length
      ? holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0)
      : null;
    const creator = d.creator || null;
    const devEntry = creator ? holders.find(h => h.owner === creator) : null;
    // v3.20: bundle analysis — detect coordinated multi-wallet supply control.
    // Bundles split across many wallets with similar sizes to dodge top-holder
    // checks. Natural distributions are power-law; bundles are flat clusters.
    const bundle = analyzeBundle(holders, creator);
    // v3.26: LP lock — for graduated coins, the dev must not be able to pull
    // the pool. markets[].lp.lpLockedPct = % of LP supply locked/burned.
    let lpLockedPct = null;
    try {
      const markets = d.markets || [];
      let best = null;
      for (const m of markets) {
        const lp = m && m.lp;
        if (!lp || lp.lpLockedPct == null) continue;
        if (best == null || lp.lpLockedUSD > (best.lpLockedUSD || 0)) best = lp;
      }
      if (best) lpLockedPct = Number(best.lpLockedPct);
    } catch { /* fail-open */ }
    const report = {
      topPct,
      top10Pct,
      holderCount: d.totalHolders != null ? d.totalHolders : null,
      devPct: devEntry ? devEntry.pct : null,
      rugged: d.rugged === true,
      risks: (d.risks || []).map(x => x.name).filter(Boolean).slice(0, 6),
      scoreNorm: d.score_normalised != null ? d.score_normalised : null,
      launchpad: d.launchpad || null,
      bundleScore: bundle.score,      // 0-100, higher = more bundled
      bundleWallets: bundle.wallets,  // count of suspected bundle wallets
      bundlePct: bundle.pct,          // combined % held by bundle wallets
      lpLockedPct,                    // v3.26: % of LP locked (graduated coins)
    };
    reportCache.set(mint, { report, ts: now });
    return report;
  } catch { return null; }
}

// v3.20: bundle pattern detection.
// Looks for flat clusters in holders 2-20 (skipping #1 which is often LP/dev).
// A bundle = 4+ wallets each holding 0.3%-8% with low variance between them.
function analyzeBundle(holders, creator) {
  const out = { score: 0, wallets: 0, pct: 0 };
  if (!holders || holders.length < 5) return out;
  // Skip holder #1 (usually LP pool or dev), analyze 2-20.
  const rest = holders.slice(1, 20).filter(h => h.pct > 0.1 && h.pct < 10);
  if (rest.length < 4) return out;
  // Check for flat cluster: low coefficient of variation = suspicious.
  const pcts = rest.map(h => h.pct);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pcts.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 99;
  // CV < 0.8 with 4+ wallets in similar range = likely bundle.
  if (cv < 0.8 && rest.length >= 4) {
    out.wallets = rest.length;
    out.pct = Math.round(pcts.reduce((a, b) => a + b, 0) * 10) / 10;
    // Score: more wallets + higher combined % = more bundled.
    out.score = Math.min(100, Math.round(rest.length * 8 + out.pct * 1.5));
  }
  return out;
}

export function curveProgress(mc) {
  if (!(mc > 0)) return null;
  return Math.min(100, (mc / PUMP_GRAD_MC) * 100);
}

// DexScreener labels pump.fun's bonding-curve venue as dexId "pumpfun"
// (not "pump") — match both so on-curve coins aren't misread as graduated.
export function isOnCurve(pair) {
  return !!pair && (pair.dexId === 'pumpfun' || pair.dexId === 'pump');
}

// v3.23: batch MC lookup for open positions — fallback when DexScreener
// hasn't indexed a fresh coin yet. Returns { mint: usd_market_cap }.
export async function fetchPumpPrices(mints) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < mints.length; i += 10) chunks.push(mints.slice(i, i + 10));
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (m) => {
        try {
          const r = await fetch(`${PF}/coins/${m}`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) return null;
          const d = await r.json();
          const mc = d.usd_market_cap;
          return mc > 0 ? { mint: m, mc } : null;
        } catch { return null; }
      })
    );
    for (const s of results) {
      if (s.status === 'fulfilled' && s.value) out[s.value.mint] = s.value.mc;
    }
  }
  return out;
}
