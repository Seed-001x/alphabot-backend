// moversenrich.js — enrich the /api/movers feed with trading-terminal data.
// v3.28: holders (RugCheck), volume/price/txns/image (DexScreener batch).
// Display-only enrichment: never throws, never blocks the base feed.

import { fetchTokens, tokenView } from './dexscreener.js';
import { fetchRugReport } from './pumpfun.js';

const ENRICH_TTL = 60000;
const MAX_ENRICH = 30;          // top 30 by MC — controls API cost
const RUG_CONCURRENCY = 5;

let cache = { key: null, data: null, ts: 0 };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Enrich movers coins with terminal data. Returns new array; originals untouched.
 * Coins missing enrichment keep their base fields (fail-open per coin).
 */
export async function enrichMovers(coins) {
  const list = (coins || []).slice(0, MAX_ENRICH);
  if (!list.length) return coins || [];

  const key = list.map(c => c.address).join(',');
  const now = Date.now();
  if (cache.key === key && cache.data && now - cache.ts < ENRICH_TTL) {
    return cache.data;
  }

  const addrs = list.map(c => c.address);

  // DexScreener: one batched call for price/volume/txns/image (60s cache inside).
  let pairs = {};
  try { pairs = await fetchTokens(addrs); } catch { pairs = {}; }

  // RugCheck: holder counts, concurrency-limited, fail-open per coin.
  const reports = await mapLimit(addrs, RUG_CONCURRENCY, (a) => fetchRugReport(a));

  const enriched = list.map((c, idx) => {
    const out = { ...c };
    const pair = pairs[c.address];
    if (pair) {
      const tv = tokenView(pair);
      if (tv) {
        if (tv.price != null) out.priceUsd = tv.price;
        if (tv.vol24h != null) out.vol24h = tv.vol24h;
        const buys = tv.buys24h || 0, sells = tv.sells24h || 0;
        if (buys || sells) out.txns24h = buys + sells;
        if (tv.image) out.image = tv.image;
        if (tv.priceChange && tv.priceChange.h24 != null) out.priceChangeH24 = +tv.priceChange.h24;
      }
    }
    const rep = reports[idx];
    if (rep && rep.holderCount != null) out.holders = rep.holderCount;
    return out;
  });

  cache = { key, data: enriched, ts: now };
  return enriched;
}
