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
    const report = {
      topPct,
      top10Pct,
      holderCount: d.totalHolders != null ? d.totalHolders : null,
      devPct: devEntry ? devEntry.pct : null,
      rugged: d.rugged === true,
      risks: (d.risks || []).map(x => x.name).filter(Boolean).slice(0, 6),
      scoreNorm: d.score_normalised != null ? d.score_normalised : null,
      launchpad: d.launchpad || null,
    };
    reportCache.set(mint, { report, ts: now });
    return report;
  } catch { return null; }
}

export function curveProgress(mc) {
  if (!(mc > 0)) return null;
  return Math.min(100, (mc / PUMP_GRAD_MC) * 100);
}

export function isOnCurve(pair) {
  return pair && pair.dexId === 'pump';
}
