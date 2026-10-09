// WHALES — real smart-money wallet buy feed for the Research Center.
// Fetches recent token buys for ALL tracked flow wallets via the Helius
// enhanced transactions API. Read-only, cached, fail-open.
// This is the data layer behind /api/whales. Never touches trading.
//
// Credit discipline (tiered polling):
//   - Priority tier (user's 10 wallets: 9 copy-trade + their own): refreshed
//     every 120s → 10 calls / 120s = 300/hr.
//   - Rotated tier (remaining 156): 20 wallets per refresh cycle, full
//     rotation every ~16 min → 20 calls / 120s = 600/hr.
//   Worst case ≈ 900 calls/hr. Each call returns ≤25 recent transactions.

import { FLOW_ADDRS } from './flowAddrs.js';
import { getKey } from './helius.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrFYD4KCoNkY11McCe8BenwNYB';
const SKIP_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

const HELIUS_ENHANCED = 'https://api.helius.xyz/v0/addresses';
const SUMMARY_TTL_MS = 120000;       // rebuild the summary at most every 120s
const PRIORITY_TTL_MS = 120000;      // user's wallets: fresh every 2 min
const ROTATED_TTL_MS = 15 * 60 * 1000; // rotated wallets: data held 15 min
const ROTATED_BATCH = 20;            // wallets refreshed per cycle
const DETAIL_TTL_MS = 120000;

// Per-wallet cache: address -> { ts, tier, data }
// data: { address, lastBuy, buys24h, buys[], error }
const walletCache = new Map();
const detailCache = new Map(); // address -> { ts, data }
let rotationCursor = 0;
let summaryCache = null; // { ts, data }

export const trunc = (a) => (a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '?'));

// All tracked wallets, deduplicated, order preserved.
export function getAllWallets() {
  const seen = new Set();
  const out = [];
  for (const a of FLOW_ADDRS) {
    if (a && !seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out;
}

// Priority tier: the user's own picks — the 9 copy-trade wallets + their
// own wallet (added 2026-10-08). Always refreshed every 120s.
const PRIORITY_WALLETS = [
  '4y2T1ghykCTq4EddoXjptZamk4qAsqcZw6eKxS8jdvE1',
  '6DQAGJT7VZPVBsuG4kn3AvpyHCEi7B2RFFvMZdbqQqqP',
  'GZ1yiJKTq8Mc6RiY2WQrzph8wJcizSLGgyhr4RSgnuUo',
  'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6',
  '8k1sAmVUjzaZkxqexeYkCPphjcQobYugQeGmCyvKtHNG',
  '5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij',
  '9oqcX4mTVdLP7MDs7ZTL7jueW5EMjXTx7bwqy57cEuww',
  'DtjZR9SdxUKbMyu4qeUVgjMJyGDhYg76BttXxfhf3z59',
  '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG',
  'BPabbM6hwqQxxfHt3rVKTN2K4NaU1jZY2GWuFj6ZCBv6',
];

export function getPriorityWallets() {
  return PRIORITY_WALLETS.filter(a => getAllWallets().includes(a));
}

async function fetchTxns(wallet, key, limit) {
  const params = new URLSearchParams({ 'api-key': key, limit: String(limit) });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${HELIUS_ENHANCED}/${wallet}/transactions?${params}`, {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`helius_${r.status}`);
    const txns = await r.json();
    return Array.isArray(txns) ? txns : [];
  } finally {
    clearTimeout(t);
  }
}

// Extract SOL→token buys from enhanced transactions.
function extractBuys(txns, wallet) {
  const buys = [];
  for (const tx of txns) {
    const ts = (tx.timestamp || 0) * 1000;
    if (!ts) continue;
    for (const tr of (tx.tokenTransfers || [])) {
      if (tr.toUserAccount !== wallet) continue;
      const mint = tr.mint;
      if (!mint || SKIP_MINTS.has(mint)) continue;
      const tokens = tr.tokenAmount || 0;
      if (!(tokens > 0)) continue;
      const solSpent = (tx.nativeTransfers || [])
        .filter(x => x.fromUserAccount === wallet)
        .reduce((s, x) => s + (x.amount || 0), 0) / 1e9;
      buys.push({
        mint,
        symbol: null, // resolved by enrichment
        tokens,
        solSpent: Math.round(solSpent * 10000) / 10000,
        ts,
        sig: tx.signature || null,
      });
    }
  }
  return buys;
}

// Batch-resolve symbols + current MC via DexScreener. Best effort.
async function enrich(buys) {
  const mints = [...new Set(buys.map(b => b.mint))];
  const meta = {};
  try {
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { signal: ctl.signal });
        if (!r.ok) continue;
        const data = await r.json();
        for (const p of (data || [])) {
          if (p && p.baseToken && p.baseToken.address) {
            meta[p.baseToken.address] = {
              symbol: p.baseToken.symbol || p.baseToken.address.slice(0, 8),
              mc: p.marketCap || p.fdv || null,
            };
          }
        }
      } finally { clearTimeout(t); }
    }
  } catch { /* enrichment is a nicety */ }
  for (const b of buys) {
    const m = meta[b.mint];
    b.symbol = (m && m.symbol) || (b.mint.length > 44 ? b.mint.slice(0, 8) : b.mint);
    b.mc = (m && m.mc) || null;
  }
  return buys;
}

async function walletBuys(address, txnLimit, maxBuys) {
  const key = getKey();
  if (!key) return { address, buys: [], error: 'no HELIUS_API_KEY' };
  try {
    const txns = await fetchTxns(address, key, txnLimit);
    let buys = extractBuys(txns, address);
    buys.sort((a, b) => b.ts - a.ts);
    buys = buys.slice(0, maxBuys);
    await enrich(buys);
    return { address, buys, error: null };
  } catch (e) {
    return { address, buys: [], error: String((e && e.message) || e).slice(0, 80) };
  }
}

function summarizeBuys(address, buys, error) {
  const now = Date.now();
  const dayAgo = now - 86400000;
  const last = buys[0] || null;
  return {
    address,
    short: trunc(address),
    lastBuy: last ? {
      symbol: last.symbol, mint: last.mint, mc: last.mc,
      solSpent: last.solSpent, ts: last.ts,
    } : null,
    buys24h: buys.filter(b => b.ts >= dayAgo).length,
    recentBuys: buys.length,
    error,
  };
}

// GET /api/whales — summary for ALL tracked wallets (last buy, 24h count).
// Tiered refresh: priority wallets every 120s; rotated wallets 20 per
// cycle (full 156-wallet rotation ≈ 16 min).
export async function getWhalesSummary() {
  if (summaryCache && Date.now() - summaryCache.ts < SUMMARY_TTL_MS) {
    return { ...summaryCache.data, cached: true };
  }
  const now = Date.now();
  const all = getAllWallets();
  const prioritySet = new Set(getPriorityWallets());
  const rotated = all.filter(a => !prioritySet.has(a));

  // Decide what to fetch this cycle.
  const toFetch = [];
  for (const a of prioritySet) {
    const c = walletCache.get(a);
    if (!c || now - c.ts > PRIORITY_TTL_MS) toFetch.push({ a, txnLimit: 25, maxBuys: 8, tier: 'priority' });
  }
  const batch = [];
  for (let i = 0; i < ROTATED_BATCH; i++) {
    const a = rotated[(rotationCursor + i) % rotated.length];
    if (!a) continue;
    const c = walletCache.get(a);
    if (!c || now - c.ts > ROTATED_TTL_MS) batch.push({ a, txnLimit: 15, maxBuys: 8, tier: 'rotated' });
  }
  rotationCursor = (rotationCursor + ROTATED_BATCH) % rotated.length;
  toFetch.push(...batch);

  // Concurrency 5 to be gentle on the RPC.
  for (let i = 0; i < toFetch.length; i += 5) {
    const results = await Promise.all(
      toFetch.slice(i, i + 5).map(t => walletBuys(t.a, t.txnLimit, t.maxBuys).then(r => ({ ...r, tier: t.tier })))
    );
    for (const r of results) {
      walletCache.set(r.address, { ts: now, tier: r.tier, data: summarizeBuys(r.address, r.buys, r.error), buys: r.buys });
    }
  }

  // Assemble the full list from cache; wallets never visited yet show pending.
  const wallets = all.map(a => {
    const c = walletCache.get(a);
    if (c) {
      return { ...c.data, tier: c.tier, dataTs: c.ts };
    }
    return { address: a, short: trunc(a), lastBuy: null, buys24h: 0, recentBuys: 0, tier: prioritySet.has(a) ? 'priority' : 'rotated', pending: true, error: null };
  });

  const freshPriority = wallets.filter(w => w.tier === 'priority' && !w.pending).length;
  const freshRotated = wallets.filter(w => w.tier === 'rotated' && !w.pending).length;

  const data = {
    wallets,
    count: wallets.length,
    ts: now,
    tiers: {
      priority: prioritySet.size,
      rotated: rotated.length,
      priorityFresh: freshPriority,
      rotatedFresh: freshRotated,
      rotatedTtlMin: 15,
    },
  };
  summaryCache = { ts: now, data };
  return { ...data, cached: false };
}

// GET /api/whales/:address/buys — buy history detail for one wallet.
export async function getWalletBuys(address) {
  const c = detailCache.get(address);
  if (c && Date.now() - c.ts < DETAIL_TTL_MS) return { ...c.data, cached: true };
  const r = await walletBuys(address, 60, 20);
  const data = {
    address: r.address,
    short: trunc(r.address),
    buys: r.buys.map(b => ({
      symbol: b.symbol, mint: b.mint, mc: b.mc,
      tokens: b.tokens, solSpent: b.solSpent, ts: b.ts, sig: b.sig,
    })),
    error: r.error,
    ts: Date.now(),
  };
  detailCache.set(address, { ts: Date.now(), data });
  // Bound the cache.
  if (detailCache.size > 60) {
    const k = detailCache.keys().next().value;
    detailCache.delete(k);
  }
  return { ...data, cached: false };
}

// v3.42: lightweight whale-accumulation check for the entry pipeline.
// Reads the in-memory walletCache only — NO network. Returns
// { wallets: n, hasData: bool } where n = distinct tracked wallets that
// bought this mint in the last 24h. hasData=false means the cache is cold
// (no wallet buy data yet) — caller decides fail-open vs fail-closed.
export function whaleBuyWallets(mint) {
  const dayAgo = Date.now() - 86400000;
  const wallets = new Set();
  let hasData = false;
  for (const [address, entry] of walletCache) {
    const buys = entry.buys || [];
    if (buys.length) hasData = true;
    for (const b of buys) {
      if (b && b.mint === mint && b.ts >= dayAgo) wallets.add(address);
    }
  }
  return { wallets: wallets.size, hasData };
}

// POST /api/research/synthesize — accumulation signals across tracked wallets.
// Finds tokens bought by 2+ distinct wallets in the last 24h, sorted by
// wallet count (then total SOL spent). Read-only; never touches trading.
export async function synthesizeResearch() {
  // Make sure we have the latest available snapshot.
  await getWhalesSummary();
  const now = Date.now();
  const dayAgo = now - 86400000;
  const byMint = new Map(); // mint -> { mint, symbol, mc, wallets:Set, buys, totalSol, lastTs }

  for (const [address, entry] of walletCache) {
    const buys = entry.buys || [];
    for (const b of buys) {
      if (!b || b.ts < dayAgo) continue;
      let rec = byMint.get(b.mint);
      if (!rec) {
        rec = { mint: b.mint, symbol: b.symbol, mc: b.mc, wallets: new Set(), buys: 0, totalSol: 0, lastTs: 0 };
        byMint.set(b.mint, rec);
      }
      rec.wallets.add(address);
      rec.buys += 1;
      rec.totalSol += b.solSpent || 0;
      if (b.ts > rec.lastTs) rec.lastTs = b.ts;
      // Keep the freshest symbol/mc.
      if (b.ts >= rec.lastTs) { rec.symbol = b.symbol; rec.mc = b.mc; }
    }
  }

  const tokens = [];
  for (const rec of byMint.values()) {
    if (rec.wallets.size < 2) continue;
    tokens.push({
      mint: rec.mint,
      symbol: rec.symbol,
      mc: rec.mc,
      walletCount: rec.wallets.size,
      buyCount: rec.buys,
      totalSol: Math.round(rec.totalSol * 10000) / 10000,
      wallets: [...rec.wallets].map(a => ({ address: a, short: trunc(a) })),
      lastBuyTs: rec.lastTs,
    });
  }
  tokens.sort((a, b) => (b.walletCount - a.walletCount) || (b.totalSol - a.totalSol));

  const withData = [...walletCache.values()].filter(e => (e.buys || []).length > 0).length;
  return {
    window: '24h',
    ts: now,
    tokens,
    tokenCount: tokens.length,
    walletCoverage: {
      total: getAllWallets().length,
      withData,
      cachedWallets: walletCache.size,
    },
  };
}
