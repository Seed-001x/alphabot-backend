// WHALES — real smart-money wallet buy feed for the Research Center.
// Fetches recent token buys for tracked flow wallets via the Helius
// enhanced transactions API. Read-only, cached, fail-open.
// This is the data layer behind /api/whales. Never touches trading.
//
// Credit discipline: summary covers 20 wallets, 1 Helius call each,
// cached 120s (~600 calls/hr worst case on the Developer plan).

import { FLOW_ADDRS } from './flowAddrs.js';
import { getKey } from './helius.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrFYD4KCoNkY11McCe8BenwNYB';
const SKIP_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

const HELIUS_ENHANCED = 'https://api.helius.xyz/v0/addresses';
const SUMMARY_TTL_MS = 120000;
const N_WALLETS = 20;

let summaryCache = null; // { ts, data }
const detailCache = new Map(); // address -> { ts, data }
const DETAIL_TTL_MS = 120000;

export const trunc = (a) => (a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '?'));

// The 20 wallets the Research Center shows: the user's own picks first
// (the 9 copy-trade wallets + their own wallet, added 2026-10-08),
// then the first 10 curated flow addresses.
export function getWhaleWallets() {
  const userAdded = FLOW_ADDRS.slice(-10);
  const curated = FLOW_ADDRS.slice(0, 10);
  const seen = new Set();
  const out = [];
  for (const a of [...userAdded, ...curated]) {
    if (a && !seen.has(a)) { seen.add(a); out.push(a); }
    if (out.length >= N_WALLETS) break;
  }
  return out;
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

// GET /api/whales — summary: 20 wallets, last buy, 24h buy count.
export async function getWhalesSummary() {
  if (summaryCache && Date.now() - summaryCache.ts < SUMMARY_TTL_MS) {
    return { ...summaryCache.data, cached: true };
  }
  const wallets = getWhaleWallets();
  // Concurrency 5 to be gentle on the RPC.
  const results = [];
  for (let i = 0; i < wallets.length; i += 5) {
    const batch = await Promise.all(wallets.slice(i, i + 5).map(a => walletBuys(a, 25, 8)));
    results.push(...batch);
  }
  const now = Date.now();
  const dayAgo = now - 86400000;
  const data = {
    wallets: results.map(r => {
      const last = r.buys[0] || null;
      return {
        address: r.address,
        short: trunc(r.address),
        lastBuy: last ? {
          symbol: last.symbol, mint: last.mint, mc: last.mc,
          solSpent: last.solSpent, ts: last.ts,
        } : null,
        buys24h: r.buys.filter(b => b.ts >= dayAgo).length,
        recentBuys: r.buys.length,
        error: r.error,
      };
    }),
    ts: now,
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
