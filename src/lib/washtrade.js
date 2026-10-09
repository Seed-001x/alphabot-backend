// src/lib/washtrade.js — bot wash-trading detection (entry filter).
// User: "if 90%+ of buys are tiny identical amounts, it's bots, not buyers."
//
// X Coin pattern: bots make tiny identical buys (~0.02 SOL) to fake volume and
// "activity"; the real MM then dumps the coin to zero. The entry pipeline saw
// the activity and bought the "dip" after the dump — an unexitable $0.00.
//
// Method: pull recent SWAP txns for the mint via Helius enhanced API, extract
// per-buyer SOL spent, and check whether >80% of buys cluster within 10% of
// the smallest buy size AND that smallest size is < 0.05 SOL (dust).
// Fail-open: no key, fetch error, or <10 buys = skip (not wash).

import { getKey } from './helius.js';

const CACHE = new Map(); // mint -> { ts, result }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per mint
const TXN_LIMIT = 50;
const MIN_BUYS = 10;
const CLUSTER_PCT = 0.10;  // within 10% of smallest buy
const WASH_RATIO = 0.80;   // >80% clustered = wash
const DUST_SOL = 0.05;     // smallest buy must be under this to count
const FETCH_TIMEOUT_MS = 8000;

function cached(mint) {
  const c = CACHE.get(mint);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.result;
  return null;
}

async function fetchMintTxns(mint, key) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(key)}&limit=${TXN_LIMIT}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) throw new Error('bad_key');
    if (!r.ok) throw new Error('helius_' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

// Extract per-buyer SOL spent from SWAP txns.
// A "buy" = a distinct wallet that RECEIVED our token and sent SOL.
function extractBuys(txns, mint) {
  const buys = [];
  for (const tx of txns || []) {
    if (tx.type !== 'SWAP') continue;
    const tokenMoves = (tx.tokenTransfers || []).filter(
      t => t.mint === mint && (t.tokenAmount || 0) > 0
    );
    if (!tokenMoves.length) continue;
    const buyers = new Set(tokenMoves.map(t => t.toUserAccount).filter(Boolean));
    const perBuyer = new Map();
    for (const nt of tx.nativeTransfers || []) {
      if (!buyers.has(nt.fromUserAccount)) continue;
      const amt = (nt.amount || 0) / 1e9;
      if (!(amt > 0)) continue;
      perBuyer.set(nt.fromUserAccount, (perBuyer.get(nt.fromUserAccount) || 0) + amt);
    }
    for (const sol of perBuyer.values()) buys.push(sol);
  }
  return buys;
}

export async function checkBuyDistribution(mint) {
  const skip = (reason, stats = {}) => ({ isWashTrade: false, reason, stats });
  if (!mint) return skip('no mint');
  const hit = cached(mint);
  if (hit) return hit;

  const key = getKey();
  if (!key) return skip('no helius key — fail-open');

  let result;
  try {
    const txns = await fetchMintTxns(mint, key);
    const buys = extractBuys(txns, mint);
    const n = buys.length;
    if (n < MIN_BUYS) {
      result = skip(`insufficient buy data (${n} < ${MIN_BUYS})`, { buys: n });
    } else {
      const smallest = Math.min(...buys);
      const lo = smallest * (1 - CLUSTER_PCT);
      const hi = smallest * (1 + CLUSTER_PCT);
      const clustered = buys.filter(b => b >= lo && b <= hi).length;
      const ratio = clustered / n;
      const sorted = [...buys].sort((a, b) => a - b);
      const median = sorted[Math.floor(n / 2)];
      const stats = {
        buys: n,
        smallestSol: +smallest.toFixed(4),
        medianSol: +median.toFixed(4),
        clusteredPct: Math.round(ratio * 100),
      };
      if (ratio > WASH_RATIO && smallest < DUST_SOL) {
        result = {
          isWashTrade: true,
          reason: `${Math.round(ratio * 100)}% of ${n} buys clustered at ~${smallest.toFixed(3)} SOL (bot wash-trading)`,
          stats,
        };
      } else {
        result = skip(`buy sizes look organic (${Math.round(ratio * 100)}% clustered)`, stats);
      }
    }
  } catch (e) {
    result = skip(`check failed (${(e && e.message) || e}) — fail-open`);
  }
  CACHE.set(mint, { ts: Date.now(), result });
  return result;
}

// Exported for unit testing the pure math without Helius.
export function analyzeBuySizes(buys) {
  const n = (buys || []).length;
  if (n < MIN_BUYS) return { isWashTrade: false, reason: `insufficient buy data (${n} < ${MIN_BUYS})` };
  const smallest = Math.min(...buys);
  const lo = smallest * (1 - CLUSTER_PCT);
  const hi = smallest * (1 + CLUSTER_PCT);
  const clustered = buys.filter(b => b >= lo && b <= hi).length;
  const ratio = clustered / n;
  if (ratio > WASH_RATIO && smallest < DUST_SOL) {
    return { isWashTrade: true, reason: `${Math.round(ratio * 100)}% of ${n} buys clustered at ~${smallest.toFixed(3)} SOL` };
  }
  return { isWashTrade: false, reason: `organic (${Math.round(ratio * 100)}% clustered)` };
}
